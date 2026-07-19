import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { ApiStatusError } from "../effect/api";
import { uploadEffect, uploadWithRetry, uploadWithRetryEffect } from "./uploads";

type Outcome = { type: "error" } | { type: "pending" } | { type: "response"; status: number; body?: string };

class FakeXMLHttpRequest extends EventTarget {
  static outcomes: Outcome[] = [];
  static sends = 0;
  static aborts = 0;

  readonly upload = new EventTarget();
  status = 0;
  responseText = "";

  open() {}
  setRequestHeader() {}

  send() {
    FakeXMLHttpRequest.sends += 1;
    queueMicrotask(() => {
      const progress = new Event("progress");
      Object.defineProperties(progress, {
        loaded: { value: 8 },
        total: { value: 16 },
        lengthComputable: { value: true },
      });
      this.upload.dispatchEvent(progress);

      const outcome = FakeXMLHttpRequest.outcomes.shift();
      if (outcome?.type === "pending") return;
      if (!outcome || outcome.type === "error") {
        this.dispatchEvent(new Event("error"));
        return;
      }
      this.status = outcome.status;
      this.responseText = outcome.body ?? "";
      this.dispatchEvent(new Event("load"));
    });
  }

  abort() {
    FakeXMLHttpRequest.aborts += 1;
    this.dispatchEvent(new Event("abort"));
  }
}

const flushMicrotasks = () => Effect.promise(() => Promise.resolve());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeXMLHttpRequest.outcomes = [];
  FakeXMLHttpRequest.sends = 0;
  FakeXMLHttpRequest.aborts = 0;
});

describe("uploadWithRetry", () => {
  it("reports upload progress through the Promise adapter", async () => {
    FakeXMLHttpRequest.outcomes = [{ type: "response", status: 201 }];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const progress = vi.fn();

    await uploadWithRetry("/upload", new Uint8Array(16), {}, { onProgress: progress, onRetry: vi.fn() });

    expect(progress).toHaveBeenCalledWith(8, 16);
    expect(FakeXMLHttpRequest.sends).toBe(1);
  });

  it.effect("retries exactly three times with exponential backoff", () => Effect.gen(function*() {
    FakeXMLHttpRequest.outcomes = [
      { type: "error" },
      { type: "error" },
      { type: "response", status: 201 },
    ];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const onRetry = vi.fn();

    const fiber = yield* Effect.forkChild(uploadWithRetryEffect(
      "/upload",
      new Uint8Array(16),
      {},
      { onProgress: vi.fn(), onRetry },
    ));
    yield* Effect.yieldNow;
    yield* flushMicrotasks();
    expect(FakeXMLHttpRequest.sends).toBe(1);

    yield* TestClock.adjust("499 millis");
    expect(FakeXMLHttpRequest.sends).toBe(1);
    yield* TestClock.adjust("1 millis");
    yield* flushMicrotasks();
    expect(FakeXMLHttpRequest.sends).toBe(2);

    yield* TestClock.adjust("999 millis");
    expect(FakeXMLHttpRequest.sends).toBe(2);
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(fiber);

    expect(onRetry.mock.calls).toEqual([[2, 3], [3, 3]]);
    expect(FakeXMLHttpRequest.sends).toBe(3);
  }));

  it.effect("waits for connectivity before applying retry backoff", () => Effect.gen(function*() {
    FakeXMLHttpRequest.outcomes = [
      { type: "error" },
      { type: "response", status: 201 },
    ];
    const browserWindow = new EventTarget();
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const fiber = yield* Effect.forkChild(uploadWithRetryEffect(
      "/upload",
      new Uint8Array(16),
      {},
      { onProgress: vi.fn(), onRetry: vi.fn() },
    ));
    yield* Effect.yieldNow;
    yield* flushMicrotasks();

    yield* TestClock.adjust("4999 millis");
    expect(FakeXMLHttpRequest.sends).toBe(1);
    browserWindow.dispatchEvent(new Event("online"));
    yield* Effect.yieldNow;
    yield* TestClock.adjust("499 millis");
    expect(FakeXMLHttpRequest.sends).toBe(1);
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(fiber);

    expect(FakeXMLHttpRequest.sends).toBe(2);
  }));

  it("accepts a conflict only after confirming the exact attachment", async () => {
    vi.useFakeTimers();
    FakeXMLHttpRequest.outcomes = [
      { type: "error" },
      { type: "response", status: 409, body: JSON.stringify({ error: "Attachment ID already exists" }) },
    ];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const confirmConflict = vi.fn(async () => true);

    const result = uploadWithRetry("/upload", new Uint8Array(16), {}, {
      onProgress: vi.fn(),
      onRetry: vi.fn(),
      confirmConflict,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBeUndefined();
    expect(confirmConflict).toHaveBeenCalledOnce();
    expect(FakeXMLHttpRequest.sends).toBe(2);
  });

  it("rejects an unrelated attachment conflict", async () => {
    FakeXMLHttpRequest.outcomes = [
      { type: "response", status: 409, body: JSON.stringify({ error: "Attachment ID is already reserved" }) },
    ];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const result = uploadWithRetry("/upload", new Uint8Array(16), {}, {
      onProgress: vi.fn(),
      onRetry: vi.fn(),
      confirmConflict: async () => false,
    });

    await expect(result).rejects.toEqual(ApiStatusError.make({
      message: "Attachment ID is already reserved",
      status: 409,
    }));
    expect(FakeXMLHttpRequest.sends).toBe(1);
  });

  it("does not retry permanent errors", async () => {
    FakeXMLHttpRequest.outcomes = [
      { type: "response", status: 413, body: JSON.stringify({ error: "Storage quota exceeded" }) },
    ];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const result = uploadWithRetry("/upload", new Uint8Array(16), {}, { onProgress: vi.fn(), onRetry: vi.fn() });

    await expect(result).rejects.toEqual(ApiStatusError.make({
      message: "Storage quota exceeded",
      status: 413,
    }));
    expect(FakeXMLHttpRequest.sends).toBe(1);
  });

  it.effect("aborts the request when interrupted", () => Effect.gen(function*() {
    FakeXMLHttpRequest.outcomes = [{ type: "pending" }];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const fiber = yield* Effect.forkChild(uploadEffect("/upload", new Uint8Array(16), {}, vi.fn()));
    yield* Effect.yieldNow;
    yield* flushMicrotasks();
    yield* Fiber.interrupt(fiber);

    expect(FakeXMLHttpRequest.aborts).toBe(1);
  }));
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import { uploadWithRetry } from "./uploads";

type Outcome = { type: "error" } | { type: "response"; status: number; body?: string };

class FakeXMLHttpRequest extends EventTarget {
  static outcomes: Outcome[] = [];
  static sends = 0;

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
      if (!outcome || outcome.type === "error") {
        this.dispatchEvent(new Event("error"));
        return;
      }
      this.status = outcome.status;
      this.responseText = outcome.body ?? "";
      this.dispatchEvent(new Event("load"));
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeXMLHttpRequest.outcomes = [];
  FakeXMLHttpRequest.sends = 0;
});

describe("uploadWithRetry", () => {
  it("reports upload progress", async () => {
    FakeXMLHttpRequest.outcomes = [{ type: "response", status: 201 }];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const progress = vi.fn();

    await uploadWithRetry("/upload", new Uint8Array(16), {}, { onProgress: progress, onRetry: vi.fn() });

    expect(progress).toHaveBeenCalledWith(8, 16);
    expect(FakeXMLHttpRequest.sends).toBe(1);
  });

  it("retries interrupted uploads", async () => {
    vi.useFakeTimers();
    FakeXMLHttpRequest.outcomes = [
      { type: "error" },
      { type: "error" },
      { type: "response", status: 201 },
    ];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const onRetry = vi.fn();

    const result = uploadWithRetry("/upload", new Uint8Array(16), {}, { onProgress: vi.fn(), onRetry });
    await vi.runAllTimersAsync();
    await result;

    expect(onRetry.mock.calls).toEqual([[2, 3], [3, 3]]);
    expect(FakeXMLHttpRequest.sends).toBe(3);
  });

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

    await expect(result).rejects.toEqual(new ApiError("Attachment ID is already reserved", 409));
    expect(FakeXMLHttpRequest.sends).toBe(1);
  });

  it("does not retry permanent errors", async () => {
    FakeXMLHttpRequest.outcomes = [
      { type: "response", status: 413, body: JSON.stringify({ error: "Storage quota exceeded" }) },
    ];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const result = uploadWithRetry("/upload", new Uint8Array(16), {}, { onProgress: vi.fn(), onRetry: vi.fn() });

    await expect(result).rejects.toEqual(new ApiError("Storage quota exceeded", 413));
    expect(FakeXMLHttpRequest.sends).toBe(1);
  });
});

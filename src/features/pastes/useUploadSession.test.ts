import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { ApiStatusError } from "../../effect/api";
import { ApiError } from "../../lib/api";
import {
  createUploadPayloadCache,
  discardUploadSession,
  type SelectedFile,
  uploadSelectedFile,
  uploadSelectedFileEffect,
  uploadUntilFailure,
} from "./useUploadSession";

class PendingXMLHttpRequest extends EventTarget {
  static sends = 0;
  static aborts = 0;

  readonly upload = new EventTarget();
  status = 0;
  responseText = "";

  open() {}
  setRequestHeader() {}
  send() {
    PendingXMLHttpRequest.sends += 1;
  }
  abort() {
    PendingXMLHttpRequest.aborts += 1;
    this.dispatchEvent(new Event("abort"));
  }
}

const payload = {
  id: "file-0000000000000001",
  body: new Uint8Array(32),
  headers: {
    "X-Pastekey-Content-IV": "AA",
    "X-Pastekey-Wrapped-Key": "AA",
    "X-Pastekey-Wrapped-Key-IV": "AA",
    "X-Pastekey-Metadata": "AA",
    "X-Pastekey-Metadata-IV": "AA",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  PendingXMLHttpRequest.sends = 0;
  PendingXMLHttpRequest.aborts = 0;
});

describe("upload payload ownership", () => {
  it("retains retry payloads and releases completed payloads", () => {
    const cache = createUploadPayloadCache();
    cache.retain("selection", payload);
    expect(cache.get("selection")).toBe(payload);
    expect(cache.size).toBe(1);

    cache.release("selection");
    expect(cache.get("selection")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("reuses encrypted bytes after failure and releases them after success", async () => {
    const cache = createUploadPayloadCache();
    const encrypt = vi.fn(async () => payload);
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const update = vi.fn();
    const selected: SelectedFile = {
      id: "selection",
      file: new File(["content"], "file.txt"),
      phase: "pending",
      progress: 0,
    };
    const pasteKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const input = {
      selected,
      session: { pasteId: "paste-000000000000001", pasteKey },
      payloads: cache,
      update,
      dependencies: { encrypt, upload, list: async () => [] },
    };

    expect(await uploadSelectedFile(input)).toBe(false);
    expect(cache.size).toBe(1);
    expect(await uploadSelectedFile(input)).toBe(true);
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ phase: "complete" }));
  });

  it.effect("aborts the default upload when the outer effect is interrupted", () => Effect.gen(function*() {
    vi.stubGlobal("XMLHttpRequest", PendingXMLHttpRequest);
    const cache = createUploadPayloadCache();
    cache.retain("selection", payload);
    const pasteKey = yield* Effect.promise(() => crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    ));

    const fiber = yield* Effect.forkChild(uploadSelectedFileEffect({
      selected: {
        id: "selection",
        file: new File(["content"], "file.txt"),
        phase: "pending",
        progress: 0,
      },
      session: { pasteId: "paste-000000000000001", pasteKey },
      payloads: cache,
      update: vi.fn(),
    }));
    yield* Effect.yieldNow;

    expect(PendingXMLHttpRequest.sends).toBe(1);
    yield* Fiber.interrupt(fiber);
    expect(PendingXMLHttpRequest.aborts).toBe(1);
    expect(cache.size).toBe(1);
  }));

  it("stops before encrypting more files after the first failure", async () => {
    const files: SelectedFile[] = ["first", "failed", "not-started"].map((id) => ({
      id,
      file: new File([id], `${id}.txt`),
      phase: "pending",
      progress: 0,
    }));
    const upload = vi.fn(async (file: SelectedFile) => file.id !== "failed");

    const result = await uploadUntilFailure(files, upload);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(result.attemptedIds).toEqual(new Set(["first", "failed"]));
    expect(result.failedIds).toEqual(new Set(["failed"]));
  });

  it("treats an already removed unfinished item as discarded", async () => {
    await expect(discardUploadSession("paste", async () => {
      throw new ApiError("Not found", 404);
    })).resolves.toBeUndefined();
    await expect(discardUploadSession("paste", async () => {
      throw ApiStatusError.make({ message: "Not found", status: 404 });
    })).resolves.toBeUndefined();
    await expect(discardUploadSession("paste", async () => {
      throw new ApiError("Unavailable", 503);
    })).rejects.toMatchObject({ status: 503 });
  });

  it("clears every payload when an upload session ends", () => {
    const cache = createUploadPayloadCache();
    cache.retain("one", payload);
    cache.retain("two", { ...payload, id: "file-0000000000000002" });
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

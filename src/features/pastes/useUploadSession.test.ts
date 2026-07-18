import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import {
  createUploadPayloadCache,
  discardUploadSession,
  type SelectedFile,
  uploadSelectedFile,
  uploadUntilFailure,
} from "./useUploadSession";

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
    const selected = {
      id: "selection",
      file: new File(["content"], "file.txt"),
      phase: "pending" as const,
      progress: 0,
    };
    const input = {
      selected,
      session: { pasteId: "paste-000000000000001", pasteKey: {} as CryptoKey },
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

  it("stops before encrypting more files after the first failure", async () => {
    const files = ["first", "failed", "not-started"].map((id) => ({
      id,
      file: new File([id], `${id}.txt`),
      phase: "pending" as const,
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

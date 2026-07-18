import { describe, expect, it } from "vitest";

import { createUploadPayloadCache } from "./useUploadSession";

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

  it("clears every payload when an upload session ends", () => {
    const cache = createUploadPayloadCache();
    cache.retain("one", payload);
    cache.retain("two", { ...payload, id: "file-0000000000000002" });
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import { shareIdFromPath, shareSecretFromHash } from "./routes";

describe("share locations", () => {
  it("separates the server-visible ID from the fragment secret", () => {
    const location = new URL("https://paste.test/s/share-id-00000000001#local-decryption-secret");
    expect(shareIdFromPath(location.pathname)).toBe("share-id-00000000001");
    expect(shareSecretFromHash(location.hash)).toBe("local-decryption-secret");
    expect(location.pathname).not.toContain("local-decryption-secret");
  });

  it("rejects malformed paths and missing fragments", () => {
    expect(shareIdFromPath("/s/short")).toBeNull();
    expect(shareIdFromPath("/api/shares/share-id-00000000001")).toBeNull();
    expect(shareSecretFromHash("")).toBe("");
    expect(shareSecretFromHash("#")).toBe("");
  });
});

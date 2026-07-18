import { describe, expect, it } from "vitest";

import { attachmentPreviewKind } from "./attachments";

describe("attachment previews", () => {
  it("allows passive browser formats and blocks active content", () => {
    expect(attachmentPreviewKind("image/png")).toBe("image");
    expect(attachmentPreviewKind("audio/mpeg")).toBe("audio");
    expect(attachmentPreviewKind("video/mp4")).toBe("video");
    expect(attachmentPreviewKind("text/plain; charset=utf-8")).toBe("text");
    expect(attachmentPreviewKind("application/json")).toBe("text");

    expect(attachmentPreviewKind("image/svg+xml")).toBeNull();
    expect(attachmentPreviewKind("text/html")).toBeNull();
    expect(attachmentPreviewKind("text/xml")).toBeNull();
    expect(attachmentPreviewKind("application/pdf")).toBeNull();
    expect(attachmentPreviewKind("application/octet-stream")).toBeNull();
  });
});

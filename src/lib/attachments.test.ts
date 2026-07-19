import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttachmentStatusError,
  attachmentPreviewKind,
  fetchDecryptedAttachment,
  type UnlockedAttachment,
} from "./attachments";

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const makeAttachment = async (content = "decrypted content") => {
  const fileKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const stored = {
    id: "file-0000000000000001",
    pasteId: "paste-000000000000001",
    ciphertextSize: content.length + 16,
    contentIv: toBase64Url(iv),
    wrappedKey: "unused",
    wrappedKeyIv: "unused",
    metadataCiphertext: "unused",
    metadataIv: "unused",
    createdAt: 1,
  };
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`pastekey/file-content/${stored.id}/${stored.pasteId}/v1`),
    },
    fileKey,
    new TextEncoder().encode(content),
  );
  const attachment: UnlockedAttachment = {
    stored,
    fileKey,
    metadata: { name: "note.txt", size: content.length, type: "text/plain" },
  };
  return { attachment, ciphertext };
};

afterEach(() => vi.restoreAllMocks());

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

describe("attachment transfer", () => {
  it("fetches and decrypts attachment content with its original MIME type", async () => {
    const { attachment, ciphertext } = await makeAttachment();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ciphertext));

    const blob = await fetchDecryptedAttachment("/content", attachment);

    expect(blob.type).toBe("text/plain");
    await expect(blob.text()).resolves.toBe("decrypted content");
  });

  it("preserves API error messages as typed status failures", async () => {
    const { attachment } = await makeAttachment();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(
      { error: "Attachment expired" },
      { status: 410 },
    ));

    await expect(fetchDecryptedAttachment("/content", attachment)).rejects.toEqual(
      AttachmentStatusError.make({ message: "Attachment expired", status: 410 }),
    );
  });

  it("aborts the underlying fetch when the browser host cancels", async () => {
    const { attachment } = await makeAttachment();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        observedSignal = init?.signal ?? undefined;
        notifyStarted?.();
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));

    const request = fetchDecryptedAttachment("/content", attachment, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(request).rejects.toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
  });
});

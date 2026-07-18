import { decryptAttachmentContent } from "./crypto";
import type { AttachmentMetadata, StoredAttachment } from "./types";

export type UnlockedAttachment = {
  stored: StoredAttachment;
  metadata: AttachmentMetadata;
  fileKey: CryptoKey;
};

export type AttachmentPreviewKind = "image" | "audio" | "video" | "text";

const PREVIEW_IMAGES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
]);

export function attachmentPreviewKind(type: string): AttachmentPreviewKind | null {
  const mime = type.toLowerCase().split(";", 1)[0]!.trim();
  if (PREVIEW_IMAGES.has(mime)) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") && mime !== "text/html" && mime !== "text/xml") return "text";
  if (mime === "application/json") return "text";
  return null;
}

export async function fetchDecryptedAttachment(endpoint: string, attachment: UnlockedAttachment) {
  const response = await fetch(endpoint);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Download failed (${response.status})`);
  }
  const plaintext = await decryptAttachmentContent(
    attachment.fileKey,
    attachment.stored,
    await response.arrayBuffer(),
  );
  return new Blob([plaintext], { type: attachment.metadata.type });
}

export async function downloadAttachment(endpoint: string, attachment: UnlockedAttachment) {
  const url = URL.createObjectURL(await fetchDecryptedAttachment(endpoint, attachment));
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.metadata.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

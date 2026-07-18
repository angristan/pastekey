import { decryptAttachmentContent } from "./crypto";
import type { AttachmentMetadata, StoredAttachment } from "./types";

export type UnlockedAttachment = {
  stored: StoredAttachment;
  metadata: AttachmentMetadata;
  fileKey: CryptoKey;
};

export async function downloadAttachment(endpoint: string, attachment: UnlockedAttachment) {
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
  const url = URL.createObjectURL(new Blob([plaintext], { type: attachment.metadata.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.metadata.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

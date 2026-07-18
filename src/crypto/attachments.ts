import type { AttachmentMetadata, StoredAttachment } from "../../shared/protocol/attachments";
import {
  AES_GCM,
  decoder,
  decryptBytes,
  encoder,
  encryptBytes,
  fromBase64Url,
  randomId,
  unwrapKey,
  wrapKey,
} from "./primitives";

export async function encryptAttachment(pasteKey: CryptoKey, pasteId: string, file: File) {
  const id = randomId();
  const fileKey = await crypto.subtle.generateKey(AES_GCM, true, ["encrypt", "decrypt"]);
  const wrapped = await wrapKey(fileKey, pasteKey, `pastekey/file/${id}/${pasteId}/v1`);
  const metadata = await encryptBytes(
    fileKey,
    encoder.encode(JSON.stringify({ name: file.name, type: file.type || "application/octet-stream", size: file.size })),
    `pastekey/file-metadata/${id}/${pasteId}/v1`,
  );
  const content = await encryptBytes(
    fileKey,
    new Uint8Array(await file.arrayBuffer()),
    `pastekey/file-content/${id}/${pasteId}/v1`,
  );

  return {
    id,
    body: content.ciphertext,
    headers: {
      "X-Pastekey-Content-IV": content.iv,
      "X-Pastekey-Wrapped-Key": wrapped.ciphertext,
      "X-Pastekey-Wrapped-Key-IV": wrapped.iv,
      "X-Pastekey-Metadata": metadata.encodedCiphertext,
      "X-Pastekey-Metadata-IV": metadata.iv,
    },
  };
}

export async function decryptAttachmentMetadata(pasteKey: CryptoKey, attachment: StoredAttachment) {
  const fileKey = await unwrapKey(
    { ciphertext: attachment.wrappedKey, iv: attachment.wrappedKeyIv },
    pasteKey,
    `pastekey/file/${attachment.id}/${attachment.pasteId}/v1`,
  );
  const plaintext = await decryptBytes(
    fileKey,
    fromBase64Url(attachment.metadataCiphertext),
    attachment.metadataIv,
    `pastekey/file-metadata/${attachment.id}/${attachment.pasteId}/v1`,
  );
  const metadata = JSON.parse(decoder.decode(plaintext)) as Partial<AttachmentMetadata>;
  if (
    typeof metadata.name !== "string" ||
    typeof metadata.type !== "string" ||
    typeof metadata.size !== "number" ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0
  ) {
    throw new Error("Invalid encrypted attachment metadata");
  }
  return { fileKey, metadata: metadata as AttachmentMetadata };
}

export async function decryptAttachmentContent(
  fileKey: CryptoKey,
  attachment: StoredAttachment,
  ciphertext: ArrayBuffer,
) {
  return decryptBytes(
    fileKey,
    new Uint8Array(ciphertext),
    attachment.contentIv,
    `pastekey/file-content/${attachment.id}/${attachment.pasteId}/v1`,
  );
}

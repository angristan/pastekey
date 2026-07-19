import type { StoredAttachment } from "../../shared/protocol/attachments";
import {
  decryptAttachmentContentEffect,
  decryptAttachmentMetadataEffect,
  encryptAttachmentEffect,
} from "../effect/crypto";
import { browserRuntime } from "../effect/runtime";

export function encryptAttachment(pasteKey: CryptoKey, pasteId: string, file: File) {
  return browserRuntime.runPromise(encryptAttachmentEffect(pasteKey, pasteId, file));
}

export function decryptAttachmentMetadata(pasteKey: CryptoKey, attachment: StoredAttachment) {
  return browserRuntime.runPromise(decryptAttachmentMetadataEffect(pasteKey, attachment));
}

export function decryptAttachmentContent(
  fileKey: CryptoKey,
  attachment: StoredAttachment,
  ciphertext: ArrayBuffer,
) {
  return browserRuntime.runPromise(decryptAttachmentContentEffect(fileKey, attachment, ciphertext));
}

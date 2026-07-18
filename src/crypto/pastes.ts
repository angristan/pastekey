import type { PastePayload, StoredPaste, StoredShare } from "../lib/types";
import {
  AES_GCM,
  PASTE_KEY_USAGES,
  decoder,
  encoder,
  fromBase64Url,
  randomId,
  toBase64Url,
  unwrapKey,
  wrapKey,
} from "./primitives";

export async function encryptNewPaste(
  accountKey: CryptoKey,
  payload: PastePayload,
  expiresAt: number | null,
) {
  const id = randomId();
  const pasteKey = await crypto.subtle.generateKey(AES_GCM, true, PASTE_KEY_USAGES);
  const encrypted = await encryptPayload(pasteKey, id, payload);
  const wrapped = await wrapKey(pasteKey, accountKey, `pastekey/owner/${id}/v1`);

  return {
    pasteKey,
    write: {
      id,
      ciphertext: encrypted.ciphertext,
      contentIv: encrypted.iv,
      wrappedKey: wrapped.ciphertext,
      wrappedKeyIv: wrapped.iv,
      expiresAt,
    },
  };
}

export async function encryptExistingPaste(
  accountKey: CryptoKey,
  pasteKey: CryptoKey,
  id: string,
  payload: PastePayload,
  expiresAt: number | null,
) {
  const encrypted = await encryptPayload(pasteKey, id, payload);
  const wrapped = await wrapKey(pasteKey, accountKey, `pastekey/owner/${id}/v1`);
  return {
    ciphertext: encrypted.ciphertext,
    contentIv: encrypted.iv,
    wrappedKey: wrapped.ciphertext,
    wrappedKeyIv: wrapped.iv,
    expiresAt,
  };
}

export async function decryptOwnedPaste(accountKey: CryptoKey, stored: StoredPaste) {
  const pasteKey = await unwrapKey(
    { ciphertext: stored.wrappedKey, iv: stored.wrappedKeyIv },
    accountKey,
    `pastekey/owner/${stored.id}/v1`,
    PASTE_KEY_USAGES,
  );
  const payload = await decryptPayload(pasteKey, stored.id, stored.ciphertext, stored.contentIv);
  return { pasteKey, payload };
}

export async function createShareEnvelope(pasteId: string, pasteKey: CryptoKey, expiresAt: number | null) {
  const id = randomId();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const shareKey = await deriveShareKey(secret, id, pasteId);
  const wrapped = await wrapKey(pasteKey, shareKey, `pastekey/share/${id}/${pasteId}/v1`);

  return {
    secret: toBase64Url(secret),
    write: {
      id,
      wrappedKey: wrapped.ciphertext,
      wrappedKeyIv: wrapped.iv,
      expiresAt,
    },
  };
}

export async function decryptSharedPaste(stored: StoredShare, encodedSecret: string) {
  const secret = fromBase64Url(encodedSecret);
  if (secret.byteLength !== 32) throw new Error("Invalid share secret");

  const shareKey = await deriveShareKey(secret, stored.id, stored.pasteId);
  const pasteKey = await unwrapKey(
    { ciphertext: stored.wrappedKey, iv: stored.wrappedKeyIv },
    shareKey,
    `pastekey/share/${stored.id}/${stored.pasteId}/v1`,
    PASTE_KEY_USAGES,
  );
  const payload = await decryptPayload(pasteKey, stored.pasteId, stored.ciphertext, stored.contentIv);
  return { pasteKey, payload };
}

async function deriveShareKey(secret: Uint8Array<ArrayBuffer>, shareId: string, pasteId: string) {
  const inputKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(`pastekey/share/${shareId}/salt/v1`),
      info: encoder.encode(`pastekey/share/${pasteId}/wrapping/v1`),
    },
    inputKey,
    AES_GCM,
    false,
    ["wrapKey", "unwrapKey"],
  );
}

async function encryptPayload(key: CryptoKey, id: string, payload: PastePayload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(`pastekey/paste/${id}/v1`) },
    key,
    plaintext,
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

async function decryptPayload(key: CryptoKey, id: string, ciphertext: string, encodedIv: string) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(encodedIv),
      additionalData: encoder.encode(`pastekey/paste/${id}/v1`),
    },
    key,
    fromBase64Url(ciphertext),
  );
  const value = JSON.parse(decoder.decode(plaintext)) as Partial<PastePayload>;
  if (typeof value.title !== "string" || typeof value.content !== "string" || typeof value.language !== "string") {
    throw new Error("Invalid encrypted paste payload");
  }
  return value as PastePayload;
}

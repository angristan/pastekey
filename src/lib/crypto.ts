import type { PastePayload, StoredPaste, StoredShare, WrappedKey } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AES_GCM = { name: "AES-GCM", length: 256 } as const;

export const PRF_INPUT = encoder.encode("pastekey/passkey-prf/v1");

export function randomId(bytes = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function generateAccountKey() {
  return crypto.subtle.generateKey(AES_GCM, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
}

export async function derivePasskeyWrappingKey(prfOutput: unknown) {
  const material = normalizePrfOutput(prfOutput);
  const inputKey = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("pastekey/passkey-kek/salt/v1"),
      info: encoder.encode("pastekey/account-key/wrapping/v1"),
    },
    inputKey,
    AES_GCM,
    false,
    ["wrapKey", "unwrapKey"],
  );
}

export async function wrapAccountKey(accountKey: CryptoKey, passkeyKey: CryptoKey, credentialId: string) {
  return wrapKey(accountKey, passkeyKey, `pastekey/account/${credentialId}/v1`);
}

export async function unwrapAccountKey(envelope: WrappedKey, passkeyKey: CryptoKey, credentialId: string) {
  return unwrapKey(envelope, passkeyKey, `pastekey/account/${credentialId}/v1`, [
    "encrypt",
    "decrypt",
    "wrapKey",
    "unwrapKey",
  ]);
}

export async function encryptNewPaste(
  accountKey: CryptoKey,
  payload: PastePayload,
  expiresAt: number | null,
) {
  const id = randomId();
  const pasteKey = await crypto.subtle.generateKey(AES_GCM, true, ["encrypt", "decrypt"]);
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
  );
  return decryptPayload(pasteKey, stored.pasteId, stored.ciphertext, stored.contentIv);
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

async function wrapKey(key: CryptoKey, wrappingKey: CryptoKey, additionalData: string): Promise<WrappedKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.wrapKey(
    "raw",
    key,
    wrappingKey,
    { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData) },
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

async function unwrapKey(
  envelope: WrappedKey,
  wrappingKey: CryptoKey,
  additionalData: string,
  usages: KeyUsage[] = ["encrypt", "decrypt"],
) {
  return crypto.subtle.unwrapKey(
    "raw",
    fromBase64Url(envelope.ciphertext),
    wrappingKey,
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv), additionalData: encoder.encode(additionalData) },
    AES_GCM,
    true,
    usages,
  );
}

export function normalizePrfOutput(value: unknown): Uint8Array<ArrayBuffer> {
  let source: Uint8Array<ArrayBufferLike>;

  if (value instanceof ArrayBuffer) {
    source = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (typeof value === "string") {
    source = fromBase64Url(value);
  } else if (Array.isArray(value)) {
    if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new Error("WebAuthn PRF returned an invalid byte array");
    }
    source = Uint8Array.from(value as number[]);
  } else {
    throw new Error(`WebAuthn PRF returned unsupported key data (${Object.prototype.toString.call(value)})`);
  }

  if (source.byteLength !== 32) {
    throw new Error(`WebAuthn PRF returned ${source.byteLength} bytes; expected 32`);
  }

  // Some authenticators return views backed by non-standard or cross-realm buffers.
  // Copy into a fresh ArrayBuffer so WebCrypto always receives a valid BufferSource.
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

export function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

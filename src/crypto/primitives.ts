import type { WrappedKey } from "../../shared/protocol/auth";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const AES_GCM = { name: "AES-GCM", length: 256 } as const;
export const PASTE_KEY_USAGES: KeyUsage[] = ["encrypt", "decrypt", "wrapKey", "unwrapKey"];

export function randomId(bytes = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, additionalData: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData) },
      key,
      plaintext,
    ),
  );
  return {
    ciphertext,
    encodedCiphertext: toBase64Url(ciphertext),
    iv: toBase64Url(iv),
  };
}

export async function decryptBytes(
  key: CryptoKey,
  ciphertext: Uint8Array<ArrayBuffer>,
  encodedIv: string,
  additionalData: string,
) {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(encodedIv),
        additionalData: encoder.encode(additionalData),
      },
      key,
      ciphertext,
    ),
  );
}

export async function wrapKey(key: CryptoKey, wrappingKey: CryptoKey, additionalData: string): Promise<WrappedKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.wrapKey(
    "raw",
    key,
    wrappingKey,
    { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData) },
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

export async function unwrapKey(
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

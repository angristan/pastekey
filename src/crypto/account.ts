import type { WrappedKey } from "../../shared/protocol/auth";
import {
  AES_GCM,
  PASTE_KEY_USAGES,
  encoder,
  fromBase64Url,
  unwrapKey,
  wrapKey,
} from "./primitives";

export const PRF_INPUT = encoder.encode("pastekey/passkey-prf/v1");

export async function generateAccountKey() {
  return crypto.subtle.generateKey(AES_GCM, true, PASTE_KEY_USAGES);
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
  return unwrapKey(envelope, passkeyKey, `pastekey/account/${credentialId}/v1`, PASTE_KEY_USAGES);
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

  // Normalize authenticator-specific and cross-realm views for WebCrypto.
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

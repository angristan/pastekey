import type { WrappedKey } from "../../shared/protocol/auth";
import {
  AES_GCM,
  PASTE_KEY_USAGES,
  decoder,
  decryptBytesEffect,
  encoder,
  encryptBytesEffect,
  fromBase64Url,
  randomId,
  toBase64Url,
  unwrapKeyEffect,
  wrapKeyEffect,
} from "../effect/crypto";
import { browserRuntime } from "../effect/runtime";

export { AES_GCM, PASTE_KEY_USAGES, decoder, encoder, fromBase64Url, randomId, toBase64Url };

export function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  additionalData: string,
) {
  return browserRuntime.runPromise(encryptBytesEffect(key, plaintext, additionalData));
}

export function decryptBytes(
  key: CryptoKey,
  ciphertext: Uint8Array<ArrayBuffer>,
  encodedIv: string,
  additionalData: string,
) {
  return browserRuntime.runPromise(decryptBytesEffect(key, ciphertext, encodedIv, additionalData));
}

export function wrapKey(key: CryptoKey, wrappingKey: CryptoKey, additionalData: string): Promise<WrappedKey> {
  return browserRuntime.runPromise(wrapKeyEffect(key, wrappingKey, additionalData));
}

export function unwrapKey(
  envelope: WrappedKey,
  wrappingKey: CryptoKey,
  additionalData: string,
  usages: KeyUsage[] = ["encrypt", "decrypt"],
) {
  return browserRuntime.runPromise(unwrapKeyEffect(envelope, wrappingKey, additionalData, usages));
}

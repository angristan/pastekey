import type { WrappedKey } from "../../shared/protocol/auth";
import {
  PRF_INPUT,
  derivePasskeyWrappingKeyEffect,
  generateAccountKeyEffect,
  normalizePrfOutput,
  unwrapAccountKeyEffect,
  wrapAccountKeyEffect,
} from "../effect/crypto";
import { browserRuntime } from "../effect/runtime";

export { PRF_INPUT, normalizePrfOutput };

export function generateAccountKey() {
  return browserRuntime.runPromise(generateAccountKeyEffect());
}

export function derivePasskeyWrappingKey(prfOutput: unknown) {
  return browserRuntime.runPromise(derivePasskeyWrappingKeyEffect(prfOutput));
}

export function wrapAccountKey(accountKey: CryptoKey, passkeyKey: CryptoKey, credentialId: string) {
  return browserRuntime.runPromise(wrapAccountKeyEffect(accountKey, passkeyKey, credentialId));
}

export function unwrapAccountKey(envelope: WrappedKey, passkeyKey: CryptoKey, credentialId: string) {
  return browserRuntime.runPromise(unwrapAccountKeyEffect(envelope, passkeyKey, credentialId));
}

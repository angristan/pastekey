import type { PastePayload, StoredPaste, StoredShare } from "../../shared/protocol/pastes";
import {
  createShareEnvelopeEffect,
  decryptOwnedPasteEffect,
  decryptSharedPasteEffect,
  encryptExistingPasteEffect,
  encryptNewPasteEffect,
} from "../effect/crypto";
import { browserRuntime } from "../effect/runtime";

export function encryptNewPaste(
  accountKey: CryptoKey,
  payload: PastePayload,
  expiresAt: number | null,
) {
  return browserRuntime.runPromise(encryptNewPasteEffect(accountKey, payload, expiresAt));
}

export function encryptExistingPaste(
  accountKey: CryptoKey,
  pasteKey: CryptoKey,
  id: string,
  payload: PastePayload,
  expiresAt: number | null,
) {
  return browserRuntime.runPromise(encryptExistingPasteEffect(accountKey, pasteKey, id, payload, expiresAt));
}

export function decryptOwnedPaste(accountKey: CryptoKey, stored: StoredPaste) {
  return browserRuntime.runPromise(decryptOwnedPasteEffect(accountKey, stored));
}

export function createShareEnvelope(pasteId: string, pasteKey: CryptoKey, expiresAt: number | null) {
  return browserRuntime.runPromise(createShareEnvelopeEffect(pasteId, pasteKey, expiresAt));
}

export function decryptSharedPaste(stored: StoredShare, encodedSecret: string) {
  return browserRuntime.runPromise(decryptSharedPasteEffect(stored, encodedSecret));
}

import type { AppContext, Bindings } from "../types";

export const MAX_CIPHERTEXT_LENGTH = 1_000_000;
export const OPAQUE_ID = /^[A-Za-z0-9_-]{20,64}$/;

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_PASTE = 10;
const DEFAULT_MAX_PASTES_PER_USER = 100;
const DEFAULT_MAX_STORAGE_BYTES = 100 * 1024 * 1024;

export function serviceLimits(env: Bindings) {
  return {
    maxFileBytes: positiveInteger(env.MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxFilesPerPaste: positiveInteger(env.MAX_FILES_PER_PASTE, DEFAULT_MAX_FILES_PER_PASTE),
    maxPastesPerUser: positiveInteger(env.MAX_PASTES_PER_USER, DEFAULT_MAX_PASTES_PER_USER),
    maxStorageBytes: positiveInteger(env.MAX_STORAGE_BYTES, DEFAULT_MAX_STORAGE_BYTES),
  };
}

export function relyingParty(c: AppContext) {
  const url = new URL(c.req.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return {
    rpID: local ? url.hostname : (c.env.RP_ID ?? url.hostname),
    origin: local ? url.origin : (c.env.ORIGIN ?? url.origin),
  };
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

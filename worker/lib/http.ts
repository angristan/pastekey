import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

import { MAX_CIPHERTEXT_LENGTH } from "./config";
import type { AppContext } from "../types";

export const SMALL_JSON_BODY_BYTES = 32 * 1024;
export const WEBAUTHN_JSON_BODY_BYTES = 128 * 1024;
export const PASTE_JSON_BODY_BYTES = MAX_CIPHERTEXT_LENGTH + 16 * 1024;

export class RequestBodyTooLargeError extends Error {}

export async function readJson<T>(c: AppContext, maxBytes: number): Promise<T | null> {
  const declaredLength = Number(c.req.header("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  const body = c.req.raw.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (cause) {
    if (cause instanceof RequestBodyTooLargeError) throw cause;
    return null;
  }
}

export function validOpaque(value: unknown, maxLength = 10_000) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value);
}

export function validExpiry(value: unknown) {
  return value === undefined || value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > Date.now());
}

export function normalizeExpiry(value: number | null | undefined) {
  return value ?? null;
}

export function parseTransports(value: string): AuthenticatorTransportFuture[] {
  try {
    return JSON.parse(value) as AuthenticatorTransportFuture[];
  } catch {
    return [];
  }
}

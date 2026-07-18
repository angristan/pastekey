import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

import type { AppContext } from "../types";

export async function readJson<T>(c: AppContext): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
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

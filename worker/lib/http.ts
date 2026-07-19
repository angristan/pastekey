import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { Effect, Schema } from "effect";

import { MAX_CIPHERTEXT_LENGTH } from "./config";
import type { AppContext } from "../types";

export const SMALL_JSON_BODY_BYTES = 32 * 1024;
export const WEBAUTHN_JSON_BODY_BYTES = 128 * 1024;
export const PASTE_JSON_BODY_BYTES = MAX_CIPHERTEXT_LENGTH + 16 * 1024;

const AuthenticatorTransports = Schema.Array(Schema.Literals([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
])).pipe(Schema.mutable);

export class RequestBodyTooLargeError extends Schema.TaggedErrorClass<RequestBodyTooLargeError>()(
  "RequestBodyTooLargeError",
  {},
) {}

export class RequestBodyReadError extends Schema.TaggedErrorClass<RequestBodyReadError>()(
  "RequestBodyReadError",
  { cause: Schema.Defect() },
) {}

export class RequestBodyParseError extends Schema.TaggedErrorClass<RequestBodyParseError>()(
  "RequestBodyParseError",
  { cause: Schema.Defect() },
) {}

const parseJson = (text: string): unknown => JSON.parse(text);

/** Reads and parses one bounded JSON body without trusting its static host type. */
export const readJson = Effect.fn("Http.readJson")(function* (
  c: AppContext,
  maxBytes: number,
) {
  const declaredLength = Number(c.req.header("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return yield* RequestBodyTooLargeError.make({});
  }

  const body = c.req.raw.body;
  if (!body) return null;

  const reader = yield* Effect.try({
    try: () => body.getReader(),
    catch: (cause) => RequestBodyReadError.make({ cause }),
  });

  return yield* Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const { done, value } = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: (cause) => RequestBodyReadError.make({ cause }),
      });
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        yield* Effect.tryPromise({
          try: () => reader.cancel(),
          catch: (cause) => RequestBodyReadError.make({ cause }),
        }).pipe(Effect.catch(() => Effect.void));
        return yield* RequestBodyTooLargeError.make({});
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return yield* Effect.try({
      try: () => parseJson(new TextDecoder().decode(bytes)),
      catch: (cause) => RequestBodyParseError.make({ cause }),
    });
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: () => reader.cancel(),
        catch: (cause) => RequestBodyReadError.make({ cause }),
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Effect.sync(() => {
          try {
            reader.releaseLock();
          } catch {
            // Cancellation may already have released the stream lock.
          }
        })),
      ),
    ),
  );
});

export const decodeJsonBody = <S extends Schema.Constraint>(
  c: AppContext,
  maxBytes: number,
  schema: S,
) => readJson(c, maxBytes).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(schema, {
    onExcessProperty: "preserve",
  })),
  Effect.catchTags({
    RequestBodyReadError: () => Effect.succeed(null),
    RequestBodyParseError: () => Effect.succeed(null),
    SchemaError: () => Effect.succeed(null),
  }),
);

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
    const parsed: unknown = JSON.parse(value);
    return Schema.decodeUnknownSync(AuthenticatorTransports)(parsed);
  } catch {
    return [];
  }
}

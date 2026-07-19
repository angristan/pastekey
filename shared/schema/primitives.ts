import { Schema } from "effect";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

export const Base64Url = Schema.String.check(
  Schema.isPattern(BASE64URL_PATTERN),
).pipe(Schema.brand("Pastekey/Base64Url"));
export type Base64Url = typeof Base64Url.Type;

export const OpaqueId = Schema.String.check(
  Schema.isPattern(OPAQUE_ID_PATTERN),
).pipe(Schema.brand("Pastekey/OpaqueId"));
export type OpaqueId = typeof OpaqueId.Type;

export const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

export const NonNegativeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

export const PositiveInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
);

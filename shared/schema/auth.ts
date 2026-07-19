import { Schema } from "effect";

import { Base64Url, OpaqueId, Timestamp } from "./primitives";

export class WrappedKey extends Schema.Class<WrappedKey>("WrappedKey")({
  ciphertext: Base64Url,
  iv: Base64Url,
}) {}

export class PasskeySummary extends Schema.Class<PasskeySummary>("PasskeySummary")({
  id: Base64Url,
  createdAt: Timestamp,
  lastUsedAt: Schema.Union([Timestamp, Schema.Null]),
  backedUp: Schema.Boolean,
  deviceType: Schema.String,
}) {}

export class MeResponse extends Schema.Class<MeResponse>("MeResponse")({
  authenticated: Schema.Boolean,
  userId: Schema.optionalKey(OpaqueId),
  passkeys: Schema.optionalKey(Schema.Array(PasskeySummary).pipe(Schema.mutable)),
}) {}

export class AuthSuccess extends Schema.Class<AuthSuccess>("AuthSuccess")({
  userId: OpaqueId,
  credentialId: Base64Url,
  wrappedAccountKey: WrappedKey,
}) {}

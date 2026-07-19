import { Schema } from "effect";

import { Base64Url, OpaqueId, Timestamp } from "./primitives";

const OpaqueEncryptedField = Base64Url.check(Schema.isMaxLength(10_000));

export class WrappedKey extends Schema.Class<WrappedKey>("WrappedKey")({
  ciphertext: OpaqueEncryptedField,
  iv: OpaqueEncryptedField,
}) {}

const AuthenticatorAttachment = Schema.Literals(["cross-platform", "platform"]);
const AuthenticatorTransport = Schema.Literals([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

class CredentialPropertiesOutput extends Schema.Class<CredentialPropertiesOutput>("CredentialPropertiesOutput")({
  rk: Schema.optionalKey(Schema.Boolean),
}) {}

class AuthenticationExtensionsClientOutputs extends Schema.Class<AuthenticationExtensionsClientOutputs>(
  "AuthenticationExtensionsClientOutputs",
)({
  appid: Schema.optionalKey(Schema.Boolean),
  credProps: Schema.optionalKey(CredentialPropertiesOutput),
  hmacCreateSecret: Schema.optionalKey(Schema.Boolean),
}) {}

class AuthenticatorAttestationResponse extends Schema.Class<AuthenticatorAttestationResponse>(
  "AuthenticatorAttestationResponse",
)({
  clientDataJSON: Base64Url,
  attestationObject: Base64Url,
  authenticatorData: Schema.optionalKey(Base64Url),
  transports: Schema.optionalKey(Schema.Array(AuthenticatorTransport).pipe(Schema.mutable)),
  publicKeyAlgorithm: Schema.optionalKey(Schema.Number),
  publicKey: Schema.optionalKey(Base64Url),
}) {}

export class WebAuthnRegistrationCredential extends Schema.Class<WebAuthnRegistrationCredential>(
  "WebAuthnRegistrationCredential",
)({
  id: Base64Url,
  rawId: Base64Url,
  response: AuthenticatorAttestationResponse,
  authenticatorAttachment: Schema.optionalKey(AuthenticatorAttachment),
  clientExtensionResults: AuthenticationExtensionsClientOutputs,
  type: Schema.Literal("public-key"),
}) {}

class AuthenticatorAssertionResponse extends Schema.Class<AuthenticatorAssertionResponse>(
  "AuthenticatorAssertionResponse",
)({
  clientDataJSON: Base64Url,
  authenticatorData: Base64Url,
  signature: Base64Url,
  userHandle: Schema.optionalKey(Base64Url),
}) {}

export class WebAuthnAuthenticationCredential extends Schema.Class<WebAuthnAuthenticationCredential>(
  "WebAuthnAuthenticationCredential",
)({
  id: Base64Url,
  rawId: Base64Url,
  response: AuthenticatorAssertionResponse,
  authenticatorAttachment: Schema.optionalKey(AuthenticatorAttachment),
  clientExtensionResults: AuthenticationExtensionsClientOutputs,
  type: Schema.Literal("public-key"),
}) {}

export class RegistrationOptionsRequest extends Schema.Class<RegistrationOptionsRequest>(
  "RegistrationOptionsRequest",
)({
  turnstileToken: Schema.optionalKey(Schema.String),
}) {}

export class RegistrationVerifyRequest extends Schema.Class<RegistrationVerifyRequest>(
  "RegistrationVerifyRequest",
)({
  credential: WebAuthnRegistrationCredential,
  wrappedAccountKey: WrappedKey,
}) {}

export class LoginVerifyRequest extends Schema.Class<LoginVerifyRequest>("LoginVerifyRequest")({
  credential: WebAuthnAuthenticationCredential,
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

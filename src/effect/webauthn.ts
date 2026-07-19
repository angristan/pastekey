import { Context, Effect, Layer, Schema } from "effect";

import { PRF_INPUT, fromBase64Url, toBase64Url } from "./crypto";

const MutableStrings = Schema.Array(Schema.String).pipe(Schema.mutable);
const CredentialType = Schema.Literal("public-key");
const Transport = Schema.Literals(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const MutableTransports = Schema.Array(Transport).pipe(Schema.mutable);

const CredentialDescriptorJson = Schema.Struct({
  id: Schema.String,
  type: CredentialType,
  transports: Schema.optionalKey(MutableTransports),
});

const PrfValuesJson = Schema.Struct({
  first: Schema.String,
  second: Schema.optionalKey(Schema.String),
});

const ClientExtensionsJson = Schema.Struct({
  appid: Schema.optionalKey(Schema.String),
  credProps: Schema.optionalKey(Schema.Boolean),
  credentialProtectionPolicy: Schema.optionalKey(Schema.String),
  enforceCredentialProtectionPolicy: Schema.optionalKey(Schema.Boolean),
  hmacCreateSecret: Schema.optionalKey(Schema.Boolean),
  largeBlob: Schema.optionalKey(Schema.Struct({
    read: Schema.optionalKey(Schema.Boolean),
    support: Schema.optionalKey(Schema.String),
    write: Schema.optionalKey(Schema.String),
  })),
  minPinLength: Schema.optionalKey(Schema.Boolean),
  prf: Schema.optionalKey(Schema.Struct({
    eval: Schema.optionalKey(PrfValuesJson),
    evalByCredential: Schema.optionalKey(Schema.Record(Schema.String, PrfValuesJson)),
  })),
});

export class CreationOptionsJson extends Schema.Class<CreationOptionsJson>("CreationOptionsJson")({
  rp: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    name: Schema.String,
  }),
  user: Schema.Struct({
    displayName: Schema.String,
    id: Schema.String,
    name: Schema.String,
  }),
  challenge: Schema.String,
  pubKeyCredParams: Schema.Array(Schema.Struct({
    alg: Schema.Number,
    type: CredentialType,
  })).pipe(Schema.mutable),
  timeout: Schema.optionalKey(Schema.Number),
  excludeCredentials: Schema.optionalKey(Schema.Array(CredentialDescriptorJson).pipe(Schema.mutable)),
  authenticatorSelection: Schema.optionalKey(Schema.Struct({
    authenticatorAttachment: Schema.optionalKey(Schema.Literals(["cross-platform", "platform"])),
    requireResidentKey: Schema.optionalKey(Schema.Boolean),
    residentKey: Schema.optionalKey(Schema.Literals(["discouraged", "preferred", "required"])),
    userVerification: Schema.optionalKey(Schema.Literals(["discouraged", "preferred", "required"])),
  })),
  hints: Schema.optionalKey(MutableStrings),
  attestation: Schema.optionalKey(Schema.Literals(["direct", "enterprise", "indirect", "none"])),
  attestationFormats: Schema.optionalKey(MutableStrings),
  extensions: Schema.optionalKey(ClientExtensionsJson),
}) {}

export class RequestOptionsJson extends Schema.Class<RequestOptionsJson>("RequestOptionsJson")({
  challenge: Schema.String,
  timeout: Schema.optionalKey(Schema.Number),
  rpId: Schema.optionalKey(Schema.String),
  allowCredentials: Schema.optionalKey(Schema.Array(CredentialDescriptorJson).pipe(Schema.mutable)),
  userVerification: Schema.optionalKey(Schema.Literals(["discouraged", "preferred", "required"])),
  hints: Schema.optionalKey(MutableStrings),
  extensions: Schema.optionalKey(ClientExtensionsJson),
}) {}

export const WebAuthnOperation = Schema.Literals([
  "assert-support",
  "convert-options",
  "create-credential",
  "get-credential",
  "read-prf",
  "serialize-credential",
]);
export type WebAuthnOperation = typeof WebAuthnOperation.Type;

export class WebAuthnError extends Schema.TaggedErrorClass<WebAuthnError>()(
  "WebAuthnError",
  {
    operation: WebAuthnOperation,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const causeMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const operationMessage = (cause: unknown, fallback: string, canceled: string) => {
  if (
    typeof cause === "object"
    && cause !== null
    && "name" in cause
    && cause.name === "NotAllowedError"
  ) {
    return canceled;
  }
  return causeMessage(cause, fallback);
};

export interface CredentialBase {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly authenticatorAttachment: string | null;
  readonly getClientExtensionResults: () => AuthenticationExtensionsClientOutputs;
}

export interface RegistrationCredential extends CredentialBase {
  readonly response: {
    readonly clientDataJSON: ArrayBuffer;
    readonly attestationObject: ArrayBuffer;
    readonly getTransports?: () => string[];
  };
}

export interface AuthenticationCredential extends CredentialBase {
  readonly response: {
    readonly clientDataJSON: ArrayBuffer;
    readonly authenticatorData: ArrayBuffer;
    readonly signature: ArrayBuffer;
    readonly userHandle: ArrayBuffer | null;
  };
}

export class WebAuthn extends Context.Service<WebAuthn, {
  readonly assertSupported: () => Effect.Effect<void, WebAuthnError>;
  readonly create: (
    options: PublicKeyCredentialCreationOptions,
  ) => Effect.Effect<RegistrationCredential, WebAuthnError>;
  readonly get: (
    options: PublicKeyCredentialRequestOptions,
  ) => Effect.Effect<AuthenticationCredential, WebAuthnError>;
}>()("pastekey/WebAuthn") {}

type WebAuthnCredentials = Pick<CredentialsContainer, "create" | "get">;

export const makeWebAuthn = (
  credentials?: WebAuthnCredentials,
) => WebAuthn.of({
  assertSupported: Effect.fn("WebAuthn.assertSupported")(function*() {
    if (!globalThis.isSecureContext || !("PublicKeyCredential" in globalThis)) {
      return yield* WebAuthnError.make({
        operation: "assert-support",
        message: "Passkeys require a modern browser in a secure context",
      });
    }
  }),
  create: Effect.fn("WebAuthn.create")(function*(options: PublicKeyCredentialCreationOptions) {
    const credential = yield* Effect.tryPromise({
      try: (signal) => (credentials ?? globalThis.navigator.credentials).create({
        publicKey: options,
        signal,
      }),
      catch: (cause) => WebAuthnError.make({
        operation: "create-credential",
        message: operationMessage(
          cause,
          "Passkey creation failed",
          "Passkey creation was canceled",
        ),
        cause,
      }),
    });
    if (!(credential instanceof PublicKeyCredential)) {
      return yield* WebAuthnError.make({
        operation: "create-credential",
        message: "Passkey creation was canceled",
      });
    }
    if (!isAttestationResponse(credential.response)) {
      return yield* WebAuthnError.make({
        operation: "create-credential",
        message: "Passkey creation returned an invalid response",
      });
    }
    return {
      id: credential.id,
      rawId: credential.rawId,
      response: credential.response,
      authenticatorAttachment: credential.authenticatorAttachment,
      getClientExtensionResults: () => credential.getClientExtensionResults(),
    };
  }),
  get: Effect.fn("WebAuthn.get")(function*(options: PublicKeyCredentialRequestOptions) {
    const credential = yield* Effect.tryPromise({
      try: (signal) => (credentials ?? globalThis.navigator.credentials).get({
        publicKey: options,
        signal,
      }),
      catch: (cause) => WebAuthnError.make({
        operation: "get-credential",
        message: operationMessage(
          cause,
          "Passkey sign-in failed",
          "Passkey sign-in was canceled",
        ),
        cause,
      }),
    });
    if (!(credential instanceof PublicKeyCredential)) {
      return yield* WebAuthnError.make({
        operation: "get-credential",
        message: "Passkey sign-in was canceled",
      });
    }
    if (!isAssertionResponse(credential.response)) {
      return yield* WebAuthnError.make({
        operation: "get-credential",
        message: "Passkey sign-in returned an invalid response",
      });
    }
    return {
      id: credential.id,
      rawId: credential.rawId,
      response: credential.response,
      authenticatorAttachment: credential.authenticatorAttachment,
      getClientExtensionResults: () => credential.getClientExtensionResults(),
    };
  }),
});

export const WebAuthnLive = Layer.succeed(WebAuthn)(makeWebAuthn());

const credentialDescriptors = (
  descriptors: ReadonlyArray<typeof CredentialDescriptorJson.Type>,
): PublicKeyCredentialDescriptor[] => {
  const parsed = PublicKeyCredential.parseRequestOptionsFromJSON({
    challenge: "AA",
    allowCredentials: descriptors.map((descriptor) => ({
      id: descriptor.id,
      type: descriptor.type,
      ...(descriptor.transports === undefined ? {} : { transports: descriptor.transports }),
    })),
  }).allowCredentials;
  if (parsed === undefined || parsed.length !== descriptors.length) {
    throw new Error("The browser could not convert the WebAuthn credential hints");
  }
  return parsed;
};

const extensions = (
  input: typeof ClientExtensionsJson.Type | undefined,
): AuthenticationExtensionsClientInputs => ({
  ...(input?.appid === undefined ? {} : { appid: input.appid }),
  ...(input?.credProps === undefined ? {} : { credProps: input.credProps }),
  ...(input?.credentialProtectionPolicy === undefined
    ? {}
    : { credentialProtectionPolicy: input.credentialProtectionPolicy }),
  ...(input?.enforceCredentialProtectionPolicy === undefined
    ? {}
    : { enforceCredentialProtectionPolicy: input.enforceCredentialProtectionPolicy }),
  ...(input?.hmacCreateSecret === undefined ? {} : { hmacCreateSecret: input.hmacCreateSecret }),
  ...(input?.minPinLength === undefined ? {} : { minPinLength: input.minPinLength }),
  ...(input?.largeBlob === undefined
    ? {}
    : {
      largeBlob: {
        ...(input.largeBlob.read === undefined ? {} : { read: input.largeBlob.read }),
        ...(input.largeBlob.support === undefined ? {} : { support: input.largeBlob.support }),
        ...(input.largeBlob.write === undefined ? {} : { write: fromBase64Url(input.largeBlob.write) }),
      },
    }),
  prf: { eval: { first: PRF_INPUT } },
});

export function creationOptions(options: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  const converted = {
    rp: options.rp,
    user: { ...options.user, id: fromBase64Url(options.user.id) },
    challenge: fromBase64Url(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.excludeCredentials === undefined
      ? {}
      : { excludeCredentials: credentialDescriptors(options.excludeCredentials) }),
    ...(options.authenticatorSelection === undefined
      ? {}
      : { authenticatorSelection: options.authenticatorSelection }),
    ...(options.hints === undefined ? {} : { hints: options.hints }),
    ...(options.attestation === undefined ? {} : { attestation: options.attestation }),
    ...(options.attestationFormats === undefined
      ? {}
      : { attestationFormats: options.attestationFormats }),
    extensions: extensions(options.extensions),
  };
  return converted;
}

export function requestOptions(options: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  const converted = {
    challenge: fromBase64Url(options.challenge),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.rpId === undefined ? {} : { rpId: options.rpId }),
    ...(options.allowCredentials === undefined
      ? {}
      : { allowCredentials: credentialDescriptors(options.allowCredentials) }),
    ...(options.userVerification === undefined ? {} : { userVerification: options.userVerification }),
    ...(options.hints === undefined ? {} : { hints: options.hints }),
    extensions: extensions(options.extensions),
  };
  return converted;
}

export function getPrfOutput(credential: CredentialBase): BufferSource {
  const output = credential.getClientExtensionResults().prf?.results?.first;
  if (output === undefined) {
    throw new Error("This passkey provider does not support encrypted vaults (WebAuthn PRF)");
  }
  return output;
}

const isAttestationResponse = (
  response: AuthenticatorResponse,
): response is AuthenticatorAttestationResponse => "attestationObject" in response;

const isAssertionResponse = (
  response: AuthenticatorResponse,
): response is AuthenticatorAssertionResponse =>
  "authenticatorData" in response && "signature" in response;

export function registrationJson(credential: RegistrationCredential) {
  const response = credential.response;
  const authenticatorAttachment = credential.authenticatorAttachment;
  const transports = typeof response.getTransports === "function"
    ? response.getTransports()
    : undefined;
  return {
    id: credential.id,
    rawId: toBase64Url(new Uint8Array(credential.rawId)),
    response: {
      clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
      attestationObject: toBase64Url(new Uint8Array(response.attestationObject)),
      ...(transports === undefined ? {} : { transports }),
    },
    ...(authenticatorAttachment === null ? {} : { authenticatorAttachment }),
    clientExtensionResults: {},
    type: "public-key",
  };
}

export function authenticationJson(credential: AuthenticationCredential) {
  const response = credential.response;
  const authenticatorAttachment = credential.authenticatorAttachment;
  return {
    id: credential.id,
    rawId: toBase64Url(new Uint8Array(credential.rawId)),
    response: {
      clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
      authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
      signature: toBase64Url(new Uint8Array(response.signature)),
      ...(response.userHandle === null
        ? {}
        : { userHandle: toBase64Url(new Uint8Array(response.userHandle)) }),
    },
    ...(authenticatorAttachment === null ? {} : { authenticatorAttachment }),
    clientExtensionResults: {},
    type: "public-key",
  };
}

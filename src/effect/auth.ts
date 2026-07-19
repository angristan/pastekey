import { Effect } from "effect";

import { AuthSuccess } from "../../shared/schema/auth";
import { ApiClient } from "./api";
import {
  derivePasskeyWrappingKeyEffect,
  generateAccountKeyEffect,
  unwrapAccountKeyEffect,
  wrapAccountKeyEffect,
} from "./crypto";
import {
  CreationOptionsJson,
  RequestOptionsJson,
  type AuthenticationCredential,
  type CredentialBase,
  type RegistrationCredential,
  WebAuthn,
  WebAuthnError,
  authenticationJson,
  creationOptions,
  getPrfOutput,
  registrationJson,
  requestOptions,
} from "./webauthn";

const jsonBody = (value: unknown) => Effect.try({
  try: () => ({ body: JSON.stringify(value) }),
  catch: (cause) => WebAuthnError.make({
    operation: "serialize-credential",
    message: "Failed to serialize the WebAuthn response",
    cause,
  }),
});

const convertCreationOptions = (options: CreationOptionsJson) => Effect.try({
  try: () => creationOptions(options),
  catch: (cause) => WebAuthnError.make({
    operation: "convert-options",
    message: cause instanceof Error ? cause.message : "Invalid passkey creation options",
    cause,
  }),
});

const convertRequestOptions = (options: RequestOptionsJson) => Effect.try({
  try: () => requestOptions(options),
  catch: (cause) => WebAuthnError.make({
    operation: "convert-options",
    message: cause instanceof Error ? cause.message : "Invalid passkey request options",
    cause,
  }),
});

const readPrfOutput = (credential: CredentialBase) => Effect.try({
  try: () => getPrfOutput(credential),
  catch: (cause) => WebAuthnError.make({
    operation: "read-prf",
    message: cause instanceof Error ? cause.message : "WebAuthn PRF did not return key material",
    cause,
  }),
});

const serializeRegistration = (credential: RegistrationCredential) => Effect.try({
  try: () => registrationJson(credential),
  catch: (cause) => WebAuthnError.make({
    operation: "serialize-credential",
    message: cause instanceof Error ? cause.message : "Invalid passkey creation response",
    cause,
  }),
});

const serializeAuthentication = (credential: AuthenticationCredential) => Effect.try({
  try: () => authenticationJson(credential),
  catch: (cause) => WebAuthnError.make({
    operation: "serialize-credential",
    message: cause instanceof Error ? cause.message : "Invalid passkey sign-in response",
    cause,
  }),
});

export const registerPasskeyEffect = Effect.fn("registerPasskey")(function*(
  existingAccountKey?: CryptoKey,
  turnstileToken?: string,
) {
  const apiClient = yield* ApiClient;
  const webAuthn = yield* WebAuthn;

  yield* webAuthn.assertSupported();
  const endpoint = existingAccountKey === undefined
    ? "/api/auth/register/options"
    : "/api/auth/passkeys/options";
  const optionsBody = yield* jsonBody(
    existingAccountKey === undefined ? { turnstileToken } : {},
  );
  const options = yield* apiClient.request(endpoint, CreationOptionsJson, {
    method: "POST",
    ...optionsBody,
  });
  const credential = yield* webAuthn.create(yield* convertCreationOptions(options));
  const prfOutput = yield* readPrfOutput(credential);
  const accountKey = existingAccountKey ?? (yield* generateAccountKeyEffect());
  const passkeyKey = yield* derivePasskeyWrappingKeyEffect(prfOutput);
  const wrappedAccountKey = yield* wrapAccountKeyEffect(accountKey, passkeyKey, credential.id);
  const credentialJson = yield* serializeRegistration(credential);
  const verificationBody = yield* jsonBody({ credential: credentialJson, wrappedAccountKey });
  const auth = yield* apiClient.request("/api/auth/register/verify", AuthSuccess, {
    method: "POST",
    ...verificationBody,
  });

  return { accountKey, auth };
});

export const unlockWithPasskeyEffect = Effect.fn("unlockWithPasskey")(function*() {
  const apiClient = yield* ApiClient;
  const webAuthn = yield* WebAuthn;

  yield* webAuthn.assertSupported();
  const options = yield* apiClient.request(
    "/api/auth/login/options",
    RequestOptionsJson,
    { method: "POST" },
  );
  const credential = yield* webAuthn.get(yield* convertRequestOptions(options));
  const prfOutput = yield* readPrfOutput(credential);
  const credentialJson = yield* serializeAuthentication(credential);
  const verificationBody = yield* jsonBody({ credential: credentialJson });
  const auth = yield* apiClient.request("/api/auth/login/verify", AuthSuccess, {
    method: "POST",
    ...verificationBody,
  });
  const passkeyKey = yield* derivePasskeyWrappingKeyEffect(prfOutput);
  const accountKey = yield* unwrapAccountKeyEffect(
    auth.wrappedAccountKey,
    passkeyKey,
    auth.credentialId,
  );
  return { accountKey, auth };
});

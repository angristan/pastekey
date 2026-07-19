import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type GenerateAuthenticationOptionsOpts,
  type GenerateRegistrationOptionsOpts,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts,
} from "@simplewebauthn/server";
import { Effect, Schema } from "effect";

export const WebAuthnOperation = Schema.Literals([
  "generate-authentication-options",
  "generate-registration-options",
  "verify-authentication",
  "verify-registration",
]);
export type WebAuthnOperation = typeof WebAuthnOperation.Type;

export class WebAuthnError extends Schema.TaggedErrorClass<WebAuthnError>()("WebAuthnError", {
  operation: WebAuthnOperation,
  cause: Schema.Defect(),
}) {}

const fail = (operation: WebAuthnOperation) => (cause: unknown) =>
  WebAuthnError.make({ operation, cause });

export const makeAuthenticationOptions = Effect.fn("generateAuthenticationOptions")(
  function*(options: GenerateAuthenticationOptionsOpts) {
    return yield* Effect.tryPromise({
      try: () => generateAuthenticationOptions(options),
      catch: fail("generate-authentication-options"),
    });
  },
);

export const makeRegistrationOptions = Effect.fn("generateRegistrationOptions")(
  function*(options: GenerateRegistrationOptionsOpts) {
    return yield* Effect.tryPromise({
      try: () => generateRegistrationOptions(options),
      catch: fail("generate-registration-options"),
    });
  },
);

export const verifyAuthentication = Effect.fn("verifyAuthentication")(
  function*(options: VerifyAuthenticationResponseOpts) {
    return yield* Effect.tryPromise({
      try: () => verifyAuthenticationResponse(options),
      catch: fail("verify-authentication"),
    });
  },
);

export const verifyRegistration = Effect.fn("verifyRegistration")(
  function*(options: VerifyRegistrationResponseOpts) {
    return yield* Effect.tryPromise({
      try: () => verifyRegistrationResponse(options),
      catch: fail("verify-registration"),
    });
  },
);

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  RequestOptionsJson,
  WebAuthnError,
  makeWebAuthn,
  requestOptions,
} from "./webauthn";

const creationOptions: PublicKeyCredentialCreationOptions = {
  rp: { name: "Pastekey" },
  user: {
    id: Uint8Array.of(1),
    name: "person",
    displayName: "Person",
  },
  challenge: Uint8Array.of(2),
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
};

const authenticationOptions: PublicKeyCredentialRequestOptions = {
  challenge: Uint8Array.of(3),
};

const canceledCredentials: Pick<CredentialsContainer, "create" | "get"> = {
  create: () => Promise.reject(new DOMException("Browser-specific message", "NotAllowedError")),
  get: () => Promise.reject(new DOMException("Different browser message", "NotAllowedError")),
};

describe("WebAuthn", () => {
  it.effect("uses a stable passkey creation cancellation message", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeWebAuthn(canceledCredentials).create(creationOptions));

      assert.instanceOf(error, WebAuthnError);
      assert.strictEqual(error.message, "Passkey creation was canceled");
    }),
  );

  it.effect("uses a stable passkey sign-in cancellation message", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeWebAuthn(canceledCredentials).get(authenticationOptions));

      assert.instanceOf(error, WebAuthnError);
      assert.strictEqual(error.message, "Passkey sign-in was canceled");
    }),
  );

  it("preserves server transport hints through the DOM JSON parser", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
    let parsedInput: PublicKeyCredentialRequestOptionsJSON | undefined;

    Object.defineProperty(globalThis, "PublicKeyCredential", {
      configurable: true,
      value: {
        parseRequestOptionsFromJSON: (
          input: PublicKeyCredentialRequestOptionsJSON,
        ): PublicKeyCredentialRequestOptions => {
          parsedInput = input;
          const descriptor: PublicKeyCredentialDescriptor = {
            id: Uint8Array.of(1),
            type: "public-key",
          };
          Object.defineProperty(descriptor, "transports", {
            enumerable: true,
            value: input.allowCredentials?.[0]?.transports,
          });
          return {
            challenge: Uint8Array.of(0),
            allowCredentials: [descriptor],
          };
        },
      },
    });

    try {
      const converted = requestOptions(new RequestOptionsJson({
        challenge: "AA",
        allowCredentials: [{
          id: "AQ",
          type: "public-key",
          transports: ["cable", "smart-card", "internal"],
        }],
      }));

      assert.deepStrictEqual(
        parsedInput?.allowCredentials?.[0]?.transports,
        ["cable", "smart-card", "internal"],
      );
      assert.deepStrictEqual(
        converted.allowCredentials?.[0]?.transports,
        ["cable", "smart-card", "internal"],
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "PublicKeyCredential");
      } else {
        Object.defineProperty(globalThis, "PublicKeyCredential", previous);
      }
    }
  });
});

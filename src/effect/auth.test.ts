import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ApiClient, makeApiClient } from "./api";
import { registerPasskeyEffect } from "./auth";
import { BrowserCrypto, BrowserCryptoLive } from "./crypto";
import { WebAuthn, type RegistrationCredential } from "./webauthn";

const creationOptions = {
  rp: { id: "paste.test", name: "Pastekey" },
  user: { id: "AQID", name: "person", displayName: "Person" },
  challenge: "BAUG",
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  extensions: { credProps: true },
};

const credential: RegistrationCredential = {
  id: "credential-id",
  rawId: Uint8Array.of(1, 2, 3).buffer,
  response: {
    clientDataJSON: Uint8Array.of(4, 5).buffer,
    attestationObject: Uint8Array.of(6, 7).buffer,
    getTransports: () => ["internal"],
  },
  authenticatorAttachment: "platform",
  getClientExtensionResults: () => ({
    prf: { results: { first: new Uint8Array(32) } },
  }),
};

describe("passkey auth workflow", () => {
  it.effect("keeps options, credential, crypto, and verification in order without retries", () => {
    const events: string[] = [];
    const requests: RequestInit[] = [];
    const apiClient = makeApiClient((input, init) => {
      const path = String(input);
      requests.push(init ?? {});
      if (path === "/api/auth/passkeys/options") {
        events.push("options");
        return Promise.resolve(Response.json(creationOptions));
      }
      events.push("verify");
      return Promise.resolve(Response.json({
        userId: "user-id-123456789012",
        credentialId: credential.id,
        wrappedAccountKey: { ciphertext: "AA", iv: "AA" },
      }, { status: 201 }));
    });
    const webAuthn = WebAuthn.of({
      assertSupported: () => Effect.void,
      create: () => Effect.sync(() => {
        events.push("credential");
        return credential;
      }),
      get: () => Effect.die("not used"),
    });
    const TestLayer = Layer.mergeAll(
      Layer.succeed(ApiClient)(apiClient),
      BrowserCryptoLive,
      Layer.succeed(WebAuthn)(webAuthn),
    );

    return Effect.gen(function*() {
      const browserCrypto = yield* BrowserCrypto;
      const accountKey = yield* browserCrypto.generateAesKey(true, [
        "encrypt",
        "decrypt",
        "wrapKey",
        "unwrapKey",
      ]);
      const result = yield* registerPasskeyEffect(accountKey);

      assert.strictEqual(result.accountKey, accountKey);
      assert.deepStrictEqual(events, ["options", "credential", "verify"]);
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(requests[0]?.body, "{}");
      assert.include(String(requests[1]?.body), '"id":"credential-id"');
      assert.include(String(requests[1]?.body), '"transports":["internal"]');
    }).pipe(Effect.provide(TestLayer));
  });
});

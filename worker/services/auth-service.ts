import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Effect, Schema } from "effect";

import type { AuthSuccess, MeResponse, WrappedKey } from "../../shared/protocol/auth";
import { fromBase64Url, randomId, toBase64Url } from "../lib/encoding";
import { isD1UniqueConstraint } from "../lib/errors";
import { parseTransports, validOpaque } from "../lib/http";
import { D1, D1Error } from "../platform/d1";
import {
  beginAuthenticationCeremony,
  beginRegistrationCeremony,
  findCeremony,
  type ChallengeRow,
} from "./auth-ceremonies";
import {
  createSessionToken,
  findCurrentUser,
  SessionError,
} from "./sessions";
import { verifyTurnstile } from "./turnstile";
import {
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
} from "./webauthn";

const CredentialDescriptorRow = Schema.Struct({
  id: Schema.String,
  transports: Schema.String,
});

const CredentialRow = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  public_key: Schema.String,
  counter: Schema.Number,
  transports: Schema.String,
  device_type: Schema.String,
  backed_up: Schema.Number,
  wrapped_account_key: Schema.String,
  wrapped_account_key_iv: Schema.String,
});

const PasskeyRow = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Number,
  lastUsedAt: Schema.Union([Schema.Number, Schema.Null]),
  backedUp: Schema.Number,
  deviceType: Schema.String,
});

const ExistingCredentialRow = Schema.Struct({ id: Schema.String });

export const AuthStatus = Schema.Literals([400, 401, 404, 409, 503]);
export type AuthStatus = typeof AuthStatus.Type;

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  status: AuthStatus,
  message: Schema.String,
}) {}

export type AuthVerifiers = {
  readonly verifyAuthentication: typeof verifyAuthentication;
  readonly verifyRegistration: typeof verifyRegistration;
};

export const defaultAuthVerifiers: AuthVerifiers = {
  verifyAuthentication,
  verifyRegistration,
};

export type AuthFailure = AuthError | D1Error | SessionError | WebAuthnError;
export type AuthOperation<A> = Effect.Effect<A, AuthFailure, D1>;

const fail = (status: AuthStatus, message: string) =>
  AuthError.make({ status, message });

const preserveD1Conflict = (error: D1Error): Effect.Effect<never, AuthError | D1Error> =>
  isD1UniqueConstraint(error.cause)
    ? Effect.fail(fail(409, "This passkey is already registered"))
    : Effect.fail(error);

export const ensureInitialRegistrationAllowed = Effect.fn("ensureInitialRegistrationAllowed")(
  function*(sessionToken: string | undefined) {
    const existing = yield* findCurrentUser(sessionToken);
    if (existing) return yield* fail(409, "Already signed in");
  },
);

export const startInitialRegistration = Effect.fn("startInitialRegistration")(
  function*(input: {
    readonly requestUrl: string;
    readonly secretKey: string | undefined;
    readonly turnstileToken: string | undefined;
    readonly remoteIp: string | undefined;
    readonly turnstileRpID: string | undefined;
    readonly rpID: string;
    readonly rpName: string;
  }) {
    const turnstile = yield* verifyTurnstile({
      requestUrl: input.requestUrl,
      secretKey: input.secretKey,
      token: input.turnstileToken,
      remoteIp: input.remoteIp,
      rpID: input.turnstileRpID,
    });
    if (!turnstile.ok) return yield* fail(turnstile.status, turnstile.error);

    return yield* beginRegistrationCeremony({
      rpName: input.rpName,
      rpID: input.rpID,
      userId: randomId(),
      kind: "register",
      excludeCredentials: [],
    });
  },
);

export const startAdditionalPasskeyRegistration = Effect.fn("startAdditionalPasskeyRegistration")(
  function*(input: { readonly userId: string; readonly rpID: string; readonly rpName: string }) {
    const d1 = yield* D1;
    const credentials = yield* d1.all(
      d1.bind(
        d1.prepare("SELECT id, transports FROM credentials WHERE user_id = ?"),
        input.userId,
      ),
      CredentialDescriptorRow,
    );
    return yield* beginRegistrationCeremony({
      rpName: input.rpName,
      rpID: input.rpID,
      userId: input.userId,
      kind: "add-passkey",
      excludeCredentials: credentials.results.map((credential) => ({
        id: credential.id,
        transports: parseTransports(credential.transports),
      })),
    });
  },
);

export const findRegistrationCeremony = Effect.fn("findRegistrationCeremony")(
  function*(id: string | undefined) {
    return id ? yield* findCeremony(id, ["register", "add-passkey"]) : null;
  },
);

export const finishRegistration = Effect.fn("finishRegistration")(
  function*(
    verifiers: AuthVerifiers,
    input: {
      readonly ceremony: ChallengeRow;
      readonly credential: RegistrationResponseJSON;
      readonly wrappedAccountKey: WrappedKey;
      readonly sessionToken: string | undefined;
      readonly rpID: string;
      readonly origin: string;
    },
  ) {
    const verification = yield* verifiers.verifyRegistration({
      response: input.credential,
      expectedChallenge: input.ceremony.challenge,
      expectedOrigin: input.origin,
      expectedRPID: input.rpID,
      requireUserVerification: true,
    }).pipe(
      Effect.catchTag("WebAuthnError", () =>
        fail(400, "Passkey registration could not be verified")),
    );
    if (!verification.verified || !verification.registrationInfo) {
      return yield* fail(400, "Passkey registration failed");
    }

    const userId = input.ceremony.user_id;
    if (!userId) return yield* fail(400, "Registration ceremony expired");

    const d1 = yield* D1;
    if (input.ceremony.kind === "add-passkey") {
      const activeUser = yield* findCurrentUser(input.sessionToken);
      if (!activeUser || activeUser !== userId) {
        return yield* fail(401, "Sign in again before adding a passkey");
      }
    }

    const info = verification.registrationInfo;
    const credential = info.credential;
    const now = Date.now();
    const statements = [];
    if (input.ceremony.kind === "register") {
      statements.push(
        d1.bind(
          d1.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)"),
          userId,
          now,
        ),
      );
    }
    statements.push(
      d1.bind(
        d1.prepare(
          `INSERT INTO credentials (
            id, user_id, public_key, counter, transports, device_type, backed_up,
            wrapped_account_key, wrapped_account_key_iv, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
        credential.id,
        userId,
        toBase64Url(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        info.credentialDeviceType,
        info.credentialBackedUp ? 1 : 0,
        input.wrappedAccountKey.ciphertext,
        input.wrappedAccountKey.iv,
        now,
      ),
      d1.bind(
        d1.prepare("DELETE FROM auth_challenges WHERE id = ?"),
        input.ceremony.id,
      ),
    );

    yield* d1.batch(statements).pipe(
      Effect.catchTag("D1Error", preserveD1Conflict),
    );

    const newSessionToken = input.ceremony.kind === "register"
      ? yield* createSessionToken(userId)
      : undefined;
    const response: AuthSuccess = {
      userId,
      credentialId: credential.id,
      wrappedAccountKey: input.wrappedAccountKey,
    };
    return { response, sessionToken: newSessionToken };
  },
);

export const startLogin = Effect.fn("startLogin")(
  function*(input: {
    readonly sessionToken: string | undefined;
    readonly rpID: string;
  }) {
    const d1 = yield* D1;
    const userId = yield* findCurrentUser(input.sessionToken);
    const credentials = userId
      ? yield* d1.all(
        d1.bind(
          d1.prepare("SELECT id, transports FROM credentials WHERE user_id = ?"),
          userId,
        ),
        CredentialDescriptorRow,
      )
      : null;
    return yield* beginAuthenticationCeremony({
      rpID: input.rpID,
      userId,
      allowCredentials: credentials?.results.map((credential) => ({
        id: credential.id,
        transports: parseTransports(credential.transports),
      })),
    });
  },
);

export const findLoginCeremony = Effect.fn("findLoginCeremony")(
  function*(id: string | undefined) {
    return id ? yield* findCeremony(id, ["login"]) : null;
  },
);

export const finishLogin = Effect.fn("finishLogin")(
  function*(
    verifiers: AuthVerifiers,
    input: {
      readonly ceremony: ChallengeRow;
      readonly credential: AuthenticationResponseJSON;
      readonly rpID: string;
      readonly origin: string;
    },
  ) {
    const d1 = yield* D1;
    const stored = yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT c.* FROM credentials c JOIN users u ON u.id = c.user_id
           WHERE c.id = ? AND u.deletion_requested_at IS NULL`,
        ),
        input.credential.id,
      ),
      CredentialRow,
    );
    if (!stored) return yield* fail(401, "Unknown passkey");
    if (input.ceremony.user_id && input.ceremony.user_id !== stored.user_id) {
      return yield* fail(401, "Passkey does not belong to the active account");
    }

    const verification = yield* verifiers.verifyAuthentication({
      response: input.credential,
      expectedChallenge: input.ceremony.challenge,
      expectedOrigin: input.origin,
      expectedRPID: input.rpID,
      credential: {
        id: stored.id,
        publicKey: fromBase64Url(stored.public_key),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: true,
    }).pipe(
      Effect.catchTag("WebAuthnError", () =>
        fail(401, "Passkey sign-in could not be verified")),
    );
    if (!verification.verified) return yield* fail(401, "Passkey sign-in failed");

    yield* d1.batch([
      d1.bind(
        d1.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?"),
        verification.authenticationInfo.newCounter,
        Date.now(),
        stored.id,
      ),
      d1.bind(
        d1.prepare("DELETE FROM auth_challenges WHERE id = ?"),
        input.ceremony.id,
      ),
    ]);
    const sessionToken = yield* createSessionToken(stored.user_id);
    const response: AuthSuccess = {
      userId: stored.user_id,
      credentialId: stored.id,
      wrappedAccountKey: {
        ciphertext: stored.wrapped_account_key,
        iv: stored.wrapped_account_key_iv,
      },
    };
    return { response, sessionToken };
  },
);

export const loadMe = Effect.fn("loadMe")(
  function*(sessionToken: string | undefined) {
    const userId = yield* findCurrentUser(sessionToken);
    if (!userId) return { authenticated: false } satisfies MeResponse;

    const d1 = yield* D1;
    const passkeys = yield* d1.all(
      d1.bind(
        d1.prepare(
          `SELECT id, created_at AS createdAt, last_used_at AS lastUsedAt,
            backed_up AS backedUp, device_type AS deviceType
           FROM credentials WHERE user_id = ? ORDER BY created_at`,
        ),
        userId,
      ),
      PasskeyRow,
    );
    return {
      authenticated: true,
      userId,
      passkeys: passkeys.results.map((key) => ({
        ...key,
        backedUp: Boolean(key.backedUp),
      })),
    } satisfies MeResponse;
  },
);

export const removePasskey = Effect.fn("removePasskey")(
  function*(userId: string, credentialId: string) {
    const d1 = yield* D1;
    const result = yield* d1.run(
      d1.bind(
        d1.prepare(
          `DELETE FROM credentials
           WHERE id = ? AND user_id = ?
             AND EXISTS (
               SELECT 1 FROM credentials remaining
               WHERE remaining.user_id = credentials.user_id
                 AND remaining.id <> credentials.id
             )`,
        ),
        credentialId,
        userId,
      ),
    );
    if (result.meta.changes) return;

    const exists = yield* d1.first(
      d1.bind(
        d1.prepare("SELECT id FROM credentials WHERE id = ? AND user_id = ?"),
        credentialId,
        userId,
      ),
      ExistingCredentialRow,
    );
    if (!exists) return yield* fail(404, "Passkey not found");
    return yield* fail(409, "Keep at least one passkey");
  },
);

export function validWrappedKey(value: WrappedKey | null | undefined): value is WrappedKey {
  return Boolean(value && validOpaque(value.ciphertext) && validOpaque(value.iv));
}

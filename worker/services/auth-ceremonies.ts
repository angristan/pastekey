import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { Effect, Schema } from "effect";

import { fromBase64Url, randomId } from "../lib/encoding";
import { D1 } from "../platform/d1";
import {
  makeAuthenticationOptions,
  makeRegistrationOptions,
} from "./webauthn";

export const CEREMONY_TTL_SECONDS = 60 * 5;

export const CeremonyKind = Schema.Literals(["register", "add-passkey", "login"]);
export type CeremonyKind = typeof CeremonyKind.Type;

const ChallengeRow = Schema.Struct({
  id: Schema.String,
  challenge: Schema.String,
  kind: CeremonyKind,
  user_id: Schema.Union([Schema.String, Schema.Null]),
  expires_at: Schema.Number,
});
export type ChallengeRow = typeof ChallengeRow.Type;

type CredentialDescriptor = {
  readonly id: string;
  readonly transports?: AuthenticatorTransportFuture[];
};

export const beginRegistrationCeremony = Effect.fn("beginRegistrationCeremony")(
  function*(input: {
    readonly rpID: string;
    readonly rpName: string;
    readonly userId: string;
    readonly kind: "register" | "add-passkey";
    readonly excludeCredentials: CredentialDescriptor[];
    readonly now?: number;
  }) {
    const options = yield* makeRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpID,
      userID: fromBase64Url(input.userId),
      userName: `pastekey-${input.userId.slice(0, 8)}`,
      userDisplayName: "Pastekey user",
      attestationType: "none",
      excludeCredentials: input.excludeCredentials,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -257],
    });
    const id = yield* storeCeremony(
      options.challenge,
      input.kind,
      input.userId,
      input.now ?? Date.now(),
    );
    return { id, options };
  },
);

export const beginAuthenticationCeremony = Effect.fn("beginAuthenticationCeremony")(
  function*(input: {
    readonly rpID: string;
    readonly userId: string | null;
    readonly allowCredentials?: CredentialDescriptor[];
    readonly now?: number;
  }) {
    const options = yield* makeAuthenticationOptions({
      rpID: input.rpID,
      userVerification: "required",
      allowCredentials: input.allowCredentials,
    });
    const id = yield* storeCeremony(
      options.challenge,
      "login",
      input.userId,
      input.now ?? Date.now(),
    );
    return { id, options };
  },
);

export const findCeremony = Effect.fn("findCeremony")(
  function*(id: string, kinds: ReadonlyArray<CeremonyKind>, now = Date.now()) {
    const d1 = yield* D1;
    const row = yield* d1.first(
      d1.bind(
        d1.prepare("SELECT * FROM auth_challenges WHERE id = ? AND expires_at > ?"),
        id,
        now,
      ),
      ChallengeRow,
    );
    return row && kinds.includes(row.kind) ? row : null;
  },
);

const storeCeremony = Effect.fn("storeCeremony")(
  function*(challenge: string, kind: CeremonyKind, userId: string | null, now: number) {
    const d1 = yield* D1;
    const id = randomId();
    yield* d1.batch([
      d1.bind(
        d1.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?"),
        now,
      ),
      d1.bind(
        d1.prepare(
          "INSERT INTO auth_challenges (id, challenge, kind, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        ),
        id,
        challenge,
        kind,
        userId,
        now,
        now + CEREMONY_TTL_SECONDS * 1000,
      ),
    ]);
    return id;
  },
);

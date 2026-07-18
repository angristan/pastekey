import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

import { fromBase64Url, randomId } from "../lib/encoding";
import type { ChallengeRow } from "../types";

export const CEREMONY_TTL_SECONDS = 60 * 5;

type CredentialDescriptor = {
  id: string;
  transports?: AuthenticatorTransportFuture[];
};

export async function beginRegistrationCeremony(
  db: D1Database,
  input: {
    rpID: string;
    rpName: string;
    userId: string;
    kind: "register" | "add-passkey";
    excludeCredentials: CredentialDescriptor[];
  },
) {
  const options = await generateRegistrationOptions({
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
  const id = await storeCeremony(db, options.challenge, input.kind, input.userId);
  return { id, options };
}

export async function beginAuthenticationCeremony(
  db: D1Database,
  input: {
    rpID: string;
    userId: string | null;
    allowCredentials?: CredentialDescriptor[];
  },
) {
  const options = await generateAuthenticationOptions({
    rpID: input.rpID,
    userVerification: "required",
    allowCredentials: input.allowCredentials,
  });
  const id = await storeCeremony(db, options.challenge, "login", input.userId);
  return { id, options };
}

export function findCeremony(
  db: D1Database,
  id: string,
  kinds: ChallengeRow["kind"][],
  now = Date.now(),
) {
  return db.prepare("SELECT * FROM auth_challenges WHERE id = ? AND expires_at > ?")
    .bind(id, now)
    .first<ChallengeRow>()
    .then((row) => row && kinds.includes(row.kind) ? row : null);
}

async function storeCeremony(
  db: D1Database,
  challenge: string,
  kind: ChallengeRow["kind"],
  userId: string | null,
  now = Date.now(),
) {
  const id = randomId();
  await db.batch([
    db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    db.prepare(
      "INSERT INTO auth_challenges (id, challenge, kind, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, challenge, kind, userId, now, now + CEREMONY_TTL_SECONDS * 1000),
  ]);
  return id;
}

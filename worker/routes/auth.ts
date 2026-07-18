import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { AuthSuccess, MeResponse, WrappedKey } from "../../shared/protocol/auth";
import { relyingParty } from "../lib/config";
import { throwUniqueConflict } from "../lib/errors";
import { fromBase64Url, randomId, toBase64Url } from "../lib/encoding";
import {
  parseTransports,
  readJson,
  SMALL_JSON_BODY_BYTES,
  validOpaque,
  WEBAUTHN_JSON_BODY_BYTES,
} from "../lib/http";
import {
  cookieOptions,
  createSession,
  currentUser,
  destroySession,
  requireUser,
} from "../services/sessions";
import { verifyTurnstile } from "../services/turnstile";
import type { AppContext, AppEnv, ChallengeRow, CredentialRow } from "../types";

const CEREMONY_COOKIE = "pk_ceremony";
const CEREMONY_TTL_SECONDS = 60 * 5;

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/api/auth/register/options", async (c) => {
  const existing = await currentUser(c);
  if (existing) return c.json({ error: "Already signed in" }, 409);

  const body = await readJson<{ turnstileToken?: string }>(c, SMALL_JSON_BODY_BYTES);
  const turnstile = await verifyTurnstile(c, body?.turnstileToken);
  if (!turnstile.ok) return c.json({ error: turnstile.error }, turnstile.status);

  return beginRegistration(c, randomId(), "register", []);
});

authRoutes.post("/api/auth/passkeys/options", requireUser, async (c) => {
  const userId = c.get("userId");
  const credentials = await c.env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string; transports: string }>();
  const excluded = credentials.results.map((credential) => ({
    id: credential.id,
    transports: parseTransports(credential.transports),
  }));
  return beginRegistration(c, userId, "add-passkey", excluded);
});

authRoutes.post("/api/auth/register/verify", async (c) => {
  const ceremony = await getCeremony(c, ["register", "add-passkey"]);
  if (!ceremony) return c.json({ error: "Registration ceremony expired" }, 400);

  const body = await readJson<{ credential: RegistrationResponseJSON; wrappedAccountKey: WrappedKey }>(c, WEBAUTHN_JSON_BODY_BYTES);
  if (!body || !validWrappedKey(body.wrappedAccountKey)) {
    return c.json({ error: "Invalid registration response" }, 400);
  }

  const { rpID, origin } = relyingParty(c);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: "Passkey registration could not be verified" }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "Passkey registration failed" }, 400);
  }

  const info = verification.registrationInfo;
  const credential = info.credential;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  if (ceremony.kind === "register") {
    statements.push(c.env.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(ceremony.user_id, now));
  } else {
    const activeUser = await currentUser(c);
    if (!activeUser || activeUser !== ceremony.user_id) {
      return c.json({ error: "Sign in again before adding a passkey" }, 401);
    }
  }

  statements.push(
    c.env.DB.prepare(
      `INSERT INTO credentials (
        id, user_id, public_key, counter, transports, device_type, backed_up,
        wrapped_account_key, wrapped_account_key_iv, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      credential.id,
      ceremony.user_id,
      toBase64Url(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
      body.wrappedAccountKey.ciphertext,
      body.wrappedAccountKey.iv,
      now,
    ),
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(ceremony.id),
  );

  try {
    await c.env.DB.batch(statements);
  } catch (cause) {
    throwUniqueConflict(cause, "This passkey is already registered");
  }

  deleteCookie(c, CEREMONY_COOKIE, { path: "/api/auth" });
  if (ceremony.kind === "register") await createSession(c, ceremony.user_id!);

  const response: AuthSuccess = {
    userId: ceremony.user_id!,
    credentialId: credential.id,
    wrappedAccountKey: body.wrappedAccountKey,
  };
  return c.json(response, 201);
});

authRoutes.post("/api/auth/login/options", async (c) => {
  const { rpID } = relyingParty(c);
  const userId = await currentUser(c);
  const credentials = userId
    ? await c.env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?")
      .bind(userId)
      .all<{ id: string; transports: string }>()
    : null;
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: credentials?.results.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports),
    })),
  });
  await storeCeremony(c, options.challenge, "login", userId);
  return c.json(options);
});

authRoutes.post("/api/auth/login/verify", async (c) => {
  const ceremony = await getCeremony(c, ["login"]);
  if (!ceremony) return c.json({ error: "Sign-in ceremony expired" }, 400);

  const body = await readJson<{ credential: AuthenticationResponseJSON }>(c, WEBAUTHN_JSON_BODY_BYTES);
  if (!body?.credential?.id) return c.json({ error: "Invalid sign-in response" }, 400);

  const stored = await c.env.DB.prepare(
    `SELECT c.* FROM credentials c JOIN users u ON u.id = c.user_id
     WHERE c.id = ? AND u.deletion_requested_at IS NULL`,
  )
    .bind(body.credential.id)
    .first<CredentialRow>();
  if (!stored) return c.json({ error: "Unknown passkey" }, 401);
  if (ceremony.user_id && ceremony.user_id !== stored.user_id) {
    return c.json({ error: "Passkey does not belong to the active account" }, 401);
  }

  const { rpID, origin } = relyingParty(c);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.id,
        publicKey: fromBase64Url(stored.public_key),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: "Passkey sign-in could not be verified" }, 401);
  }

  if (!verification.verified) return c.json({ error: "Passkey sign-in failed" }, 401);

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").bind(
      verification.authenticationInfo.newCounter,
      Date.now(),
      stored.id,
    ),
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(ceremony.id),
  ]);
  deleteCookie(c, CEREMONY_COOKIE, { path: "/api/auth" });
  await createSession(c, stored.user_id);

  const response: AuthSuccess = {
    userId: stored.user_id,
    credentialId: stored.id,
    wrappedAccountKey: {
      ciphertext: stored.wrapped_account_key,
      iv: stored.wrapped_account_key_iv,
    },
  };
  return c.json(response);
});

authRoutes.get("/api/auth/me", async (c) => {
  const userId = await currentUser(c);
  if (!userId) return c.json<MeResponse>({ authenticated: false });

  const passkeys = await c.env.DB.prepare(
    `SELECT id, created_at AS createdAt, last_used_at AS lastUsedAt,
      backed_up AS backedUp, device_type AS deviceType
     FROM credentials WHERE user_id = ? ORDER BY created_at`,
  )
    .bind(userId)
    .all<{ id: string; createdAt: number; lastUsedAt: number | null; backedUp: number; deviceType: string }>();

  return c.json<MeResponse>({
    authenticated: true,
    userId,
    passkeys: passkeys.results.map((key) => ({ ...key, backedUp: Boolean(key.backedUp) })),
  });
});

authRoutes.post("/api/auth/logout", async (c) => {
  await destroySession(c);
  return c.body(null, 204);
});

authRoutes.delete("/api/auth/passkeys/:id", requireUser, async (c) => {
  const userId = c.get("userId");
  const credentialId = c.req.param("id");
  const result = await c.env.DB.prepare(
    `DELETE FROM credentials
     WHERE id = ? AND user_id = ?
       AND EXISTS (
         SELECT 1 FROM credentials remaining
         WHERE remaining.user_id = credentials.user_id
           AND remaining.id <> credentials.id
       )`,
  )
    .bind(credentialId, userId)
    .run();
  if (result.meta.changes) return c.body(null, 204);

  const exists = await c.env.DB.prepare("SELECT id FROM credentials WHERE id = ? AND user_id = ?")
    .bind(credentialId, userId)
    .first();
  if (!exists) return c.json({ error: "Passkey not found" }, 404);
  return c.json({ error: "Keep at least one passkey" }, 409);
});

async function beginRegistration(
  c: AppContext,
  userId: string,
  kind: "register" | "add-passkey",
  excludeCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[],
) {
  const { rpID } = relyingParty(c);
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME ?? "Pastekey",
    rpID,
    userID: fromBase64Url(userId),
    userName: `pastekey-${userId.slice(0, 8)}`,
    userDisplayName: "Pastekey user",
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
  });
  await storeCeremony(c, options.challenge, kind, userId);
  return c.json(options);
}

async function storeCeremony(
  c: AppContext,
  challenge: string,
  kind: ChallengeRow["kind"],
  userId: string | null,
) {
  const id = randomId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    c.env.DB.prepare(
      "INSERT INTO auth_challenges (id, challenge, kind, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, challenge, kind, userId, now, now + CEREMONY_TTL_SECONDS * 1000),
  ]);
  setCookie(c, CEREMONY_COOKIE, id, cookieOptions(c, CEREMONY_TTL_SECONDS, "/api/auth"));
}

async function getCeremony(c: AppContext, kinds: ChallengeRow["kind"][]) {
  const id = getCookie(c, CEREMONY_COOKIE);
  if (!id) return null;
  const row = await c.env.DB.prepare("SELECT * FROM auth_challenges WHERE id = ? AND expires_at > ?")
    .bind(id, Date.now())
    .first<ChallengeRow>();
  if (!row || !kinds.includes(row.kind)) return null;
  return row;
}

function validWrappedKey(value: WrappedKey | null | undefined): value is WrappedKey {
  return Boolean(value && validOpaque(value.ciphertext) && validOpaque(value.iv));
}

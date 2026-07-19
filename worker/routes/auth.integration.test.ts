import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashToken } from "../lib/encoding";
import { SESSION_TTL_SECONDS } from "../services/sessions";
import { verifyAuthentication, verifyRegistration } from "../services/webauthn";
import { createAuthRoutes } from "./auth";
import type { Bindings } from "../types";

const bindings = env as unknown as Bindings;
const context = createExecutionContext();
const credentialId = "auth-credential-00000001";
const userId = "auth-user-000000000001";
const otherUserId = "auth-user-000000000002";
const authenticationVerifier = vi.fn<typeof verifyAuthentication>();
const registrationVerifier = vi.fn<typeof verifyRegistration>();
const testRoutes = createAuthRoutes({
  verifyAuthentication: authenticationVerifier,
  verifyRegistration: registrationVerifier,
});

describe("authentication ceremonies", () => {
  afterEach(async () => {
    await bindings.DB.prepare("DELETE FROM users WHERE id IN (SELECT user_id FROM credentials WHERE id = ?)")
      .bind(credentialId)
      .run();
    await bindings.DB.prepare("DELETE FROM users WHERE id IN (?, ?)")
      .bind(userId, otherUserId)
      .run();
    await bindings.DB.prepare("DELETE FROM auth_challenges").run();
    authenticationVerifier.mockReset();
    registrationVerifier.mockReset();
  });

  it("rejects malformed and structurally invalid ceremony payloads", async () => {
    const malformed = await request("/api/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(malformed.status).toBe(400);

    const options = await request("/api/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const registration = await request("/api/auth/register/verify", {
      method: "POST",
      headers: { Cookie: ceremonyCookie(options), "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: { id: credentialId },
        wrappedAccountKey: { ciphertext: "AA", iv: "AA" },
      }),
    });
    expect(registration.status).toBe(400);
    await expect(registration.json()).resolves.toEqual({ error: "Invalid registration response" });
    expect(registrationVerifier).not.toHaveBeenCalled();

    const loginOptions = await request("/api/auth/login/options", { method: "POST" });
    const login = await request("/api/auth/login/verify", {
      method: "POST",
      headers: { Cookie: ceremonyCookie(loginOptions), "Content-Type": "application/json" },
      body: JSON.stringify({ credential: { id: credentialId } }),
    });
    expect(login.status).toBe(400);
    await expect(login.json()).resolves.toEqual({ error: "Invalid sign-in response" });
    expect(authenticationVerifier).not.toHaveBeenCalled();
  });

  it("registers, consumes the ceremony once, and logs in", async () => {
    const options = await request("/api/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(options.status).toBe(200);
    const registrationCookie = ceremonyCookie(options);
    const challenge = await bindings.DB.prepare(
      "SELECT kind, user_id AS userId FROM auth_challenges WHERE id = ?",
    ).bind(cookieValue(registrationCookie)).first<{ kind: string; userId: string | null }>();
    expect(challenge).toMatchObject({ kind: "register" });
    expect(challenge?.userId).toEqual(expect.any(String));

    const registrationVerification: VerifiedRegistrationResponse = {
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credential: {
          id: credentialId,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ["internal"],
        },
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "http://localhost",
      },
    };
    registrationVerifier.mockReturnValue(Effect.succeed(registrationVerification));

    const verifyBody = {
      credential: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: { clientDataJSON: "AA", attestationObject: "AA" },
        clientExtensionResults: {},
      } satisfies RegistrationResponseJSON,
      wrappedAccountKey: { ciphertext: "AA", iv: "AA" },
    };
    const registration = await request("/api/auth/register/verify", {
      method: "POST",
      headers: { Cookie: registrationCookie, "Content-Type": "application/json" },
      body: JSON.stringify(verifyBody),
    });
    const registrationBody = await registration.json();
    expect(registration.status, JSON.stringify(registrationBody)).toBe(201);
    expect(registrationBody).toMatchObject({ credentialId });

    const replay = await request("/api/auth/register/verify", {
      method: "POST",
      headers: { Cookie: registrationCookie, "Content-Type": "application/json" },
      body: JSON.stringify(verifyBody),
    });
    expect(replay.status).toBe(400);

    const loginOptions = await request("/api/auth/login/options", { method: "POST" });
    expect(loginOptions.status).toBe(200);
    const loginCookie = ceremonyCookie(loginOptions);
    const authenticationVerification: VerifiedAuthenticationResponse = {
      verified: true,
      authenticationInfo: {
        credentialID: credentialId,
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "http://localhost",
        rpID: "localhost",
      },
    };
    authenticationVerifier.mockReturnValue(Effect.succeed(authenticationVerification));
    const loginCredential = {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: {
        clientDataJSON: "AA",
        authenticatorData: "AA",
        signature: "AA",
      },
      clientExtensionResults: {},
    } satisfies AuthenticationResponseJSON;
    const login = await request("/api/auth/login/verify", {
      method: "POST",
      headers: { Cookie: loginCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ credential: loginCredential }),
    });
    expect(login.status).toBe(200);
    await expect(login.json()).resolves.toMatchObject({ credentialId });

    const credential = await bindings.DB.prepare("SELECT counter FROM credentials WHERE id = ?")
      .bind(credentialId)
      .first<{ counter: number }>();
    expect(credential?.counter).toBe(1);

    const sessionCookie = cookieNamed(login, "pk_session");
    const session = await bindings.DB.prepare("SELECT user_id AS userId FROM sessions WHERE id = ?")
      .bind(await hashToken(cookieValue(sessionCookie)))
      .first<{ userId: string }>();
    const owner = await bindings.DB.prepare("SELECT user_id AS userId FROM credentials WHERE id = ?")
      .bind(credentialId)
      .first<{ userId: string }>();
    expect(session).toEqual(owner);
    expect(await bindings.DB.prepare("SELECT id FROM auth_challenges WHERE id = ?")
      .bind(cookieValue(loginCookie)).first()).toBeNull();
  });

  it("rejects missing, expired, unknown, and deleting-account login contexts", async () => {
    const credential = loginCredential(credentialId);

    const missing = await request("/api/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "Sign-in ceremony expired" });

    const expiredOptions = await request("/api/auth/login/options", { method: "POST" });
    const expiredCookie = ceremonyCookie(expiredOptions);
    await bindings.DB.prepare("UPDATE auth_challenges SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, cookieValue(expiredCookie)).run();
    const expired = await request("/api/auth/login/verify", {
      method: "POST",
      headers: { Cookie: expiredCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    expect(expired.status).toBe(400);
    await expect(expired.json()).resolves.toEqual({ error: "Sign-in ceremony expired" });

    const unknownOptions = await request("/api/auth/login/options", { method: "POST" });
    const unknown = await request("/api/auth/login/verify", {
      method: "POST",
      headers: { Cookie: ceremonyCookie(unknownOptions), "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    expect(unknown.status).toBe(401);
    await expect(unknown.json()).resolves.toEqual({ error: "Unknown passkey" });

    await seedCredential(userId, credentialId);
    await bindings.DB.prepare(
      "UPDATE users SET deletion_requested_at = ?, deletion_workflow_id = ? WHERE id = ?",
    ).bind(Date.now(), "auth-login-deletion", userId).run();
    const deletingOptions = await request("/api/auth/login/options", { method: "POST" });
    const deleting = await request("/api/auth/login/verify", {
      method: "POST",
      headers: { Cookie: ceremonyCookie(deletingOptions), "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    expect(deleting.status).toBe(401);
    await expect(deleting.json()).resolves.toEqual({ error: "Unknown passkey" });
    expect(authenticationVerifier).not.toHaveBeenCalled();
  });

  it("rejects a credential outside an account-bound ceremony", async () => {
    await seedCredential(userId, credentialId);
    await bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)")
      .bind(otherUserId, Date.now()).run();
    const ceremonyId = "account-bound-login-0001";
    await bindings.DB.prepare(
      `INSERT INTO auth_challenges (id, challenge, kind, user_id, created_at, expires_at)
       VALUES (?, 'test-challenge', 'login', ?, ?, ?)`,
    ).bind(ceremonyId, otherUserId, Date.now(), Date.now() + 60_000).run();

    const response = await request("/api/auth/login/verify", {
      method: "POST",
      headers: { Cookie: `pk_ceremony=${ceremonyId}`, "Content-Type": "application/json" },
      body: JSON.stringify({ credential: loginCredential(credentialId) }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Passkey does not belong to the active account",
    });
    expect(authenticationVerifier).not.toHaveBeenCalled();
  });

  it("consumes a login ceremony once and creates one session atomically", async () => {
    await seedCredential(userId, credentialId);
    const options = await request("/api/auth/login/options", { method: "POST" });
    const loginCookie = ceremonyCookie(options);
    authenticationVerifier.mockReturnValue(Effect.succeed(authenticationSuccess(credentialId, 1)));
    const init = () => ({
      method: "POST",
      headers: { Cookie: loginCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ credential: loginCredential(credentialId) }),
    });

    const responses = await Promise.all([
      request("/api/auth/login/verify", init()),
      request("/api/auth/login/verify", init()),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 400]);
    const failed = responses.find(({ status }) => status === 400);
    if (!failed) throw new Error("Expected one rejected concurrent login");
    await expect(failed.json()).resolves.toEqual({ error: "Sign-in ceremony expired" });
    const sessions = await bindings.DB.prepare(
      `SELECT COUNT(*) AS count, MIN(expires_at - created_at) AS ttl
       FROM sessions WHERE user_id = ?`,
    ).bind(userId).first<{ count: number; ttl: number }>();
    expect(sessions).toEqual({ count: 1, ttl: SESSION_TTL_SECONDS * 1000 });
    expect(await bindings.DB.prepare("SELECT id FROM auth_challenges WHERE id = ?")
      .bind(cookieValue(loginCookie)).first()).toBeNull();
  });
});

async function seedCredential(seedUserId: string, seedCredentialId: string) {
  const now = Date.now();
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)")
      .bind(seedUserId, now),
    bindings.DB.prepare(
      `INSERT INTO credentials (
        id, user_id, public_key, counter, transports, device_type, backed_up,
        wrapped_account_key, wrapped_account_key_iv, created_at
      ) VALUES (?, ?, 'AQID', 0, '["internal"]', 'singleDevice', 0, 'AA', 'AA', ?)`,
    ).bind(seedCredentialId, seedUserId, now),
  ]);
}

function loginCredential(id: string): AuthenticationResponseJSON {
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: "AA",
      authenticatorData: "AA",
      signature: "AA",
    },
    clientExtensionResults: {},
  };
}

function authenticationSuccess(id: string, counter: number): VerifiedAuthenticationResponse {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: id,
      newCounter: counter,
      userVerified: true,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      origin: "http://localhost",
      rpID: "localhost",
    },
  };
}

function request(path: string, init: RequestInit) {
  return testRoutes.fetch(new Request(`http://localhost${path}`, init), bindings, context);
}

function ceremonyCookie(response: Response) {
  return cookieNamed(response, "pk_ceremony");
}

function cookieNamed(response: Response, name: string) {
  const header = response.headers.get("Set-Cookie");
  const cookie = header?.split(",").map((value) => value.trim().split(";")[0])
    .find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return cookie;
}

function cookieValue(cookie: string) {
  return cookie.slice(cookie.indexOf("=") + 1);
}

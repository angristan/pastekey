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

import { verifyAuthentication, verifyRegistration } from "../services/webauthn";
import { createAuthRoutes } from "./auth";
import type { Bindings } from "../types";

const bindings = env as unknown as Bindings;
const context = createExecutionContext();
const credentialId = "auth-credential-00000001";
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
    await bindings.DB.prepare("DELETE FROM auth_challenges").run();
    authenticationVerifier.mockReset();
    registrationVerifier.mockReset();
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
  });
});

function request(path: string, init: RequestInit) {
  return testRoutes.fetch(new Request(`http://localhost${path}`, init), bindings, context);
}

function ceremonyCookie(response: Response) {
  const header = response.headers.get("Set-Cookie");
  const cookie = header?.split(";")[0];
  if (!cookie?.startsWith("pk_ceremony=")) throw new Error("Missing ceremony cookie");
  return cookie;
}

function cookieValue(cookie: string) {
  return cookie.slice(cookie.indexOf("=") + 1);
}

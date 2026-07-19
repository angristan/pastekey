import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { WrappedKey } from "../../shared/protocol/auth";
import { relyingParty } from "../lib/config";
import {
  readJson,
  SMALL_JSON_BODY_BYTES,
  WEBAUTHN_JSON_BODY_BYTES,
} from "../lib/http";
import { runWorkerEffect } from "../runtime";
import {
  type AuthError,
  type AuthOperation,
  type AuthVerifiers,
  defaultAuthVerifiers,
  ensureInitialRegistrationAllowed,
  findLoginCeremony,
  findRegistrationCeremony,
  finishLogin,
  finishRegistration,
  loadMe,
  removePasskey,
  startAdditionalPasskeyRegistration,
  startInitialRegistration,
  startLogin,
  validWrappedKey,
} from "../services/auth-service";
import { CEREMONY_TTL_SECONDS } from "../services/auth-ceremonies";
import {
  cookieOptions,
  deleteSessionToken,
  requireUser,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "../services/sessions";
import type { AppContext, AppEnv } from "../types";

const CEREMONY_COOKIE = "pk_ceremony";

type AuthExecution<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: AuthError };

const runAuth = <A>(
  c: AppContext,
  effect: AuthOperation<A>,
): Promise<AuthExecution<A>> =>
  runWorkerEffect(
    c.env,
    effect.pipe(
      Effect.map((value) => ({ ok: true, value }) satisfies AuthExecution<A>),
      Effect.catchTag("AuthError", (error) =>
        Effect.succeed({ ok: false, error } satisfies AuthExecution<A>)),
    ),
  );

export function createAuthRoutes(
  verifiers: AuthVerifiers = defaultAuthVerifiers,
) {
  const authRoutes = new Hono<AppEnv>();

  authRoutes.post("/api/auth/register/options", async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    const availability = await runAuth(c, ensureInitialRegistrationAllowed(sessionToken));
    if (!availability.ok) {
      return c.json({ error: availability.error.message }, availability.error.status);
    }

    const body = await readJson<{ turnstileToken?: string }>(c, SMALL_JSON_BODY_BYTES);
    const { rpID } = relyingParty(c);
    const outcome = await runAuth(c, startInitialRegistration({
      requestUrl: c.req.url,
      secretKey: c.env.TURNSTILE_SECRET_KEY,
      turnstileToken: body?.turnstileToken,
      remoteIp: c.req.header("CF-Connecting-IP"),
      turnstileRpID: c.env.RP_ID,
      rpID,
      rpName: c.env.RP_NAME ?? "Pastekey",
    }));
    if (!outcome.ok) return c.json({ error: outcome.error.message }, outcome.error.status);

    setCookie(c, CEREMONY_COOKIE, outcome.value.id, cookieOptions(c, CEREMONY_TTL_SECONDS, "/api/auth"));
    return c.json(outcome.value.options);
  });

  authRoutes.post("/api/auth/passkeys/options", requireUser, async (c) => {
    const { rpID } = relyingParty(c);
    const ceremony = await runWorkerEffect(c.env, startAdditionalPasskeyRegistration({
      userId: c.get("userId"),
      rpID,
      rpName: c.env.RP_NAME ?? "Pastekey",
    }));
    setCookie(c, CEREMONY_COOKIE, ceremony.id, cookieOptions(c, CEREMONY_TTL_SECONDS, "/api/auth"));
    return c.json(ceremony.options);
  });

  authRoutes.post("/api/auth/register/verify", async (c) => {
    const ceremony = await runWorkerEffect(
      c.env,
      findRegistrationCeremony(getCookie(c, CEREMONY_COOKIE)),
    );
    if (!ceremony) return c.json({ error: "Registration ceremony expired" }, 400);

    const body = await readJson<{
      credential: RegistrationResponseJSON;
      wrappedAccountKey: WrappedKey;
    }>(c, WEBAUTHN_JSON_BODY_BYTES);
    if (!body || !validWrappedKey(body.wrappedAccountKey)) {
      return c.json({ error: "Invalid registration response" }, 400);
    }

    const { rpID, origin } = relyingParty(c);
    const outcome = await runAuth(c, finishRegistration(verifiers, {
      ceremony,
      credential: body.credential,
      wrappedAccountKey: body.wrappedAccountKey,
      sessionToken: getCookie(c, SESSION_COOKIE),
      rpID,
      origin,
    }));
    if (!outcome.ok) return c.json({ error: outcome.error.message }, outcome.error.status);

    deleteCookie(c, CEREMONY_COOKIE, { path: "/api/auth" });
    if (outcome.value.sessionToken) {
      setCookie(c, SESSION_COOKIE, outcome.value.sessionToken, cookieOptions(c, SESSION_TTL_SECONDS, "/"));
    }
    return c.json(outcome.value.response, 201);
  });

  authRoutes.post("/api/auth/login/options", async (c) => {
    const { rpID } = relyingParty(c);
    const ceremony = await runWorkerEffect(c.env, startLogin({
      sessionToken: getCookie(c, SESSION_COOKIE),
      rpID,
    }));
    setCookie(c, CEREMONY_COOKIE, ceremony.id, cookieOptions(c, CEREMONY_TTL_SECONDS, "/api/auth"));
    return c.json(ceremony.options);
  });

  authRoutes.post("/api/auth/login/verify", async (c) => {
    const ceremony = await runWorkerEffect(
      c.env,
      findLoginCeremony(getCookie(c, CEREMONY_COOKIE)),
    );
    if (!ceremony) return c.json({ error: "Sign-in ceremony expired" }, 400);

    const body = await readJson<{ credential: AuthenticationResponseJSON }>(c, WEBAUTHN_JSON_BODY_BYTES);
    if (!body?.credential?.id) return c.json({ error: "Invalid sign-in response" }, 400);

    const { rpID, origin } = relyingParty(c);
    const outcome = await runAuth(c, finishLogin(verifiers, {
      ceremony,
      credential: body.credential,
      rpID,
      origin,
    }));
    if (!outcome.ok) return c.json({ error: outcome.error.message }, outcome.error.status);

    deleteCookie(c, CEREMONY_COOKIE, { path: "/api/auth" });
    const sessionToken = outcome.value.sessionToken;
    setCookie(c, SESSION_COOKIE, sessionToken, cookieOptions(c, SESSION_TTL_SECONDS, "/"));
    return c.json(outcome.value.response);
  });

  authRoutes.get("/api/auth/me", async (c) =>
    c.json(await runWorkerEffect(c.env, loadMe(getCookie(c, SESSION_COOKIE)))));

  authRoutes.post("/api/auth/logout", async (c) => {
    await runWorkerEffect(c.env, deleteSessionToken(getCookie(c, SESSION_COOKIE)));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  authRoutes.delete("/api/auth/passkeys/:id", requireUser, async (c) => {
    const credentialId = c.req.param("id");
    if (!credentialId) return c.json({ error: "Passkey not found" }, 404);
    const outcome = await runAuth(c, removePasskey(c.get("userId"), credentialId));
    if (!outcome.ok) return c.json({ error: outcome.error.message }, outcome.error.status);
    return c.body(null, 204);
  });

  return authRoutes;
}

export const authRoutes = createAuthRoutes();

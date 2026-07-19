import { Effect, Schema } from "effect";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Next } from "hono";

import { hashToken, randomId } from "../lib/encoding";
import { D1 } from "../platform/d1";
import { runWorkerEffect } from "../runtime";
import type { AppContext } from "../types";

export const SESSION_COOKIE = "pk_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const RECENT_AUTH_WINDOW_MS = 5 * 60 * 1_000;

const CurrentSessionRow = Schema.Struct({
  userId: Schema.String,
  createdAt: Schema.Number,
});
export type CurrentSession = typeof CurrentSessionRow.Type;

export const SessionOperation = Schema.Literals(["hash-token", "create"]);
export type SessionOperation = typeof SessionOperation.Type;

export class SessionError extends Schema.TaggedErrorClass<SessionError>()("SessionError", {
  operation: SessionOperation,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const hashedToken = Effect.fn("hashSessionToken")(
  function*(token: string) {
    return yield* Effect.tryPromise({
      try: () => hashToken(token),
      catch: (cause) => SessionError.make({
        operation: "hash-token",
        message: "Session token could not be hashed",
        cause,
      }),
    });
  },
);

export const findCurrentSession = Effect.fn("findCurrentSession")(
  function*(token: string | undefined, now = Date.now()) {
    if (!token) return null;
    const d1 = yield* D1;
    const id = yield* hashedToken(token);
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT s.user_id AS userId, s.created_at AS createdAt
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = ? AND s.expires_at > ? AND u.deletion_requested_at IS NULL`,
        ),
        id,
        now,
      ),
      CurrentSessionRow,
    );
  },
);

export const findCurrentUser = Effect.fn("findCurrentUser")(
  function*(token: string | undefined, now = Date.now()) {
    const session = yield* findCurrentSession(token, now);
    return session?.userId ?? null;
  },
);

export const createSessionMaterial = Effect.fn("createSessionMaterial")(
  function*(now = Date.now()) {
    const token = randomId(32);
    const id = yield* hashedToken(token);
    return {
      token,
      id,
      createdAt: now,
      expiresAt: now + SESSION_TTL_SECONDS * 1000,
    };
  },
);

export const createSessionToken = Effect.fn("createSessionToken")(
  function*(userId: string, now = Date.now()) {
    const d1 = yield* D1;
    const session = yield* createSessionMaterial(now);
    const result = yield* d1.run(
      d1.bind(
        d1.prepare(
          `INSERT INTO sessions (id, user_id, created_at, expires_at)
           SELECT ?, id, ?, ? FROM users WHERE id = ? AND deletion_requested_at IS NULL`,
        ),
        session.id,
        session.createdAt,
        session.expiresAt,
        userId,
      ),
    );
    if (!result.meta.changes) {
      return yield* SessionError.make({
        operation: "create",
        message: "Account is unavailable",
      });
    }
    return session.token;
  },
);

export const deleteSessionToken = Effect.fn("deleteSessionToken")(
  function*(token: string | undefined) {
    if (!token) return;
    const d1 = yield* D1;
    const id = yield* hashedToken(token);
    yield* d1.run(
      d1.bind(d1.prepare("DELETE FROM sessions WHERE id = ?"), id),
    );
  },
);

export async function requireUser(c: AppContext, next: Next) {
  const userId = await currentUser(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  c.set("userId", userId);
  await next();
}

export async function requireRecentUser(c: AppContext, next: Next) {
  const session = await currentSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  if (session.createdAt < Date.now() - RECENT_AUTH_WINDOW_MS) {
    return c.json({ error: "Verify your passkey again before deleting the account" }, 401);
  }
  c.set("userId", session.userId);
  await next();
}

export function currentUser(c: AppContext) {
  return runWorkerEffect(c.env, findCurrentUser(getCookie(c, SESSION_COOKIE)));
}

export function currentSession(c: AppContext) {
  return runWorkerEffect(c.env, findCurrentSession(getCookie(c, SESSION_COOKIE)));
}

export async function createSession(c: AppContext, userId: string) {
  const token = await runWorkerEffect(c.env, createSessionToken(userId));
  setCookie(c, SESSION_COOKIE, token, cookieOptions(c, SESSION_TTL_SECONDS, "/"));
}

export async function destroySession(c: AppContext) {
  await runWorkerEffect(c.env, deleteSessionToken(getCookie(c, SESSION_COOKIE)));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function cookieOptions(c: AppContext, maxAge: number, path: string): {
  readonly httpOnly: boolean;
  readonly sameSite: "Strict";
  readonly secure: boolean;
  readonly path: string;
  readonly maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:",
    path,
    maxAge,
  };
}

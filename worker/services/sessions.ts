import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Next } from "hono";

import { hashToken, randomId } from "../lib/encoding";
import type { AppContext } from "../types";

export const SESSION_COOKIE = "pk_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const RECENT_AUTH_WINDOW_MS = 5 * 60 * 1_000;

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

export async function currentUser(c: AppContext) {
  return (await currentSession(c))?.userId ?? null;
}

export async function currentSession(c: AppContext) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return c.env.DB.prepare(
    `SELECT s.user_id AS userId, s.created_at AS createdAt
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ? AND u.deletion_requested_at IS NULL`,
  )
    .bind(await hashToken(token), Date.now())
    .first<{ userId: string; createdAt: number }>();
}

export async function createSession(c: AppContext, userId: string) {
  const token = randomId(32);
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at)
     SELECT ?, id, ?, ? FROM users WHERE id = ? AND deletion_requested_at IS NULL`,
  )
    .bind(await hashToken(token), now, now + SESSION_TTL_SECONDS * 1000, userId)
    .run();
  if (!result.meta.changes) throw new Error("Account is unavailable");
  setCookie(c, SESSION_COOKIE, token, cookieOptions(c, SESSION_TTL_SECONDS, "/"));
}

export async function destroySession(c: AppContext) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await hashToken(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function cookieOptions(c: AppContext, maxAge: number, path: string) {
  return {
    httpOnly: true,
    sameSite: "Strict" as const,
    secure: new URL(c.req.url).protocol === "https:",
    path,
    maxAge,
  };
}

import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Next } from "hono";

import { hashToken, randomId } from "../lib/encoding";
import type { AppContext } from "../types";

export const SESSION_COOKIE = "pk_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function requireUser(c: AppContext, next: Next) {
  const userId = await currentUser(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);
  c.set("userId", userId);
  await next();
}

export async function currentUser(c: AppContext) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = await c.env.DB.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(await hashToken(token), Date.now())
    .first<{ user_id: string }>();
  return session?.user_id ?? null;
}

export async function createSession(c: AppContext, userId: string) {
  const token = randomId(32);
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(token), userId, now, now + SESSION_TTL_SECONDS * 1000)
    .run();
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

import { Hono } from "hono";

import { randomId } from "../lib/encoding";
import { destroySession, requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.delete("/api/account", requireUser, async (c) => {
  const userId = c.get("userId");
  const workflowId = `account-${randomId()}`;
  const requestedAt = Date.now();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET deletion_requested_at = ?, deletion_workflow_id = ?
       WHERE id = ? AND deletion_requested_at IS NULL`,
    ).bind(requestedAt, workflowId, userId),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE user_id = ?").bind(userId),
  ]);
  if (!results[0]?.meta.changes) return c.json({ error: "Account deletion is already in progress" }, 409);

  try {
    await c.env.ACCOUNT_DELETION.create({
      id: workflowId,
      params: { userId },
      retention: { successRetention: "1 day", errorRetention: "3 days" },
    });
  } catch {
    await c.env.DB.prepare(
      `UPDATE users SET deletion_requested_at = NULL, deletion_workflow_id = NULL
       WHERE id = ? AND deletion_workflow_id = ?`,
    )
      .bind(userId, workflowId)
      .run();
    console.error("Account deletion workflow could not be started");
    return c.json({ error: "Account deletion could not be started. Please sign in and try again." }, 503);
  }

  await destroySession(c);
  return c.json({ status: "deleting" }, 202);
});

import { Hono } from "hono";

import { destroySession, requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.delete("/api/account", requireUser, async (c) => {
  const userId = c.get("userId");
  const workflowId = accountDeletionWorkflowId(userId);
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
    // Workflow creation can succeed remotely even if its response is lost. Keep the durable
    // deletion intent so scheduled reconciliation can safely recover either outcome.
    console.error("Account deletion workflow start is awaiting reconciliation");
  }

  await destroySession(c);
  return c.json({ status: "deleting" }, 202);
});

export function accountDeletionWorkflowId(userId: string) {
  return `account-${userId}`;
}

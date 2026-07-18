import { Hono } from "hono";

import {
  accountDeletionWorkflowId,
  startAccountDeletionWorkflow,
} from "../services/account-deletions";
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

  await startAccountDeletionWorkflow(c.env, userId, workflowId);
  await destroySession(c);
  return c.json({ status: "deleting" }, 202);
});

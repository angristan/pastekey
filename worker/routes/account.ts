import { Hono } from "hono";

import { runWorkerEffect } from "../runtime";
import { requestAccountDeletion } from "../services/account-deletions";
import { destroySession, requireRecentUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.delete("/api/account", requireRecentUser, async (c) => {
  const requested = await runWorkerEffect(
    c.env,
    requestAccountDeletion(c.get("userId")),
    {
      name: "pastekey.account.deletion.request",
      trigger: "http",
    },
  );
  if (!requested) return c.json({ error: "Account deletion is already in progress" }, 409);

  await destroySession(c);
  return c.json({ status: "deleting" }, 202);
});

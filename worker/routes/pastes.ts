import { Hono } from "hono";

import { PasteUpdate, PasteWrite } from "../../shared/schema/pastes";
import { OPAQUE_ID, serviceLimits } from "../lib/config";
import { decodeJsonBody, PASTE_JSON_BODY_BYTES, validExpiry } from "../lib/http";
import { findActiveOwnedPaste, listActiveOwnedPastes } from "../repositories/pastes";
import { runWorkerEffect } from "../runtime";
import { enqueuePendingDeletions } from "../services/deletions";
import { createPaste, deletePaste, updatePaste } from "../services/paste-mutations";
import { requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const pasteRoutes = new Hono<AppEnv>();

pasteRoutes.get("/api/pastes", requireUser, async (c) => {
  const pastes = await runWorkerEffect(
    c.env,
    listActiveOwnedPastes(c.get("userId")),
  );
  return c.json({ pastes });
});

pasteRoutes.get("/api/pastes/:id", requireUser, async (c) => {
  const paste = await runWorkerEffect(
    c.env,
    findActiveOwnedPaste(c.req.param("id")!, c.get("userId")),
  );
  if (paste === null) return c.json({ error: "Item not found" }, 404);
  return c.json(paste);
});

pasteRoutes.post("/api/pastes", requireUser, async (c) => {
  const body = await runWorkerEffect(
    c.env,
    decodeJsonBody(c, PASTE_JSON_BODY_BYTES, PasteWrite),
  );
  if (body === null || !validExpiry(body.expiresAt)) {
    return c.json({ error: "Invalid encrypted item" }, 400);
  }

  const outcome = await runWorkerEffect(
    c.env,
    createPaste(
      c.get("userId"),
      body,
      serviceLimits(c.env).maxPastesPerUser,
    ),
  );
  if (outcome.status === "account-unavailable") {
    return c.json({ error: "Account is unavailable" }, 409);
  }
  if (outcome.status === "quota-reached") {
    return c.json({ error: "Item quota reached. Delete an item before creating another." }, 413);
  }
  return c.json({ id: body.id, createdAt: outcome.createdAt }, 201);
});

pasteRoutes.put("/api/pastes/:id", requireUser, async (c) => {
  const body = await runWorkerEffect(
    c.env,
    decodeJsonBody(c, PASTE_JSON_BODY_BYTES, PasteUpdate),
  );
  const id = c.req.param("id")!;
  if (body === null || !OPAQUE_ID.test(id) || !validExpiry(body.expiresAt)) {
    return c.json({ error: "Invalid encrypted item" }, 400);
  }

  const updated = await runWorkerEffect(
    c.env,
    updatePaste(id, c.get("userId"), body),
  );
  if (!updated) return c.json({ error: "Item not found" }, 404);
  return c.json({ id });
});

pasteRoutes.delete("/api/pastes/:id", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const ownerId = c.get("userId");
  const deleted = await runWorkerEffect(c.env, deletePaste(pasteId, ownerId));
  if (!deleted) return c.json({ error: "Item not found" }, 404);

  c.executionCtx.waitUntil(
    enqueuePendingDeletions(c.env).catch(() => console.error("Could not dispatch pending ciphertext deletions")),
  );
  return c.body(null, 204);
});

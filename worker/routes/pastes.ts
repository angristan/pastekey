import { Hono } from "hono";

import type { PasteWrite } from "../../shared/protocol/pastes";
import { MAX_CIPHERTEXT_LENGTH, OPAQUE_ID } from "../lib/config";
import { PASTE_JSON_BODY_BYTES, readJson, validExpiry, validOpaque } from "../lib/http";
import { findActiveOwnedPaste, listActiveOwnedPastes } from "../repositories/pastes";
import { enqueuePendingDeletions } from "../services/deletions";
import { createPaste, deletePaste, updatePaste } from "../services/paste-mutations";
import { requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const pasteRoutes = new Hono<AppEnv>();

pasteRoutes.get("/api/pastes", requireUser, async (c) => {
  const rows = await listActiveOwnedPastes(c.env.DB, c.get("userId"));
  return c.json({ pastes: rows.results });
});

pasteRoutes.get("/api/pastes/:id", requireUser, async (c) => {
  const paste = await findActiveOwnedPaste(c.env.DB, c.req.param("id")!, c.get("userId"));
  if (!paste) return c.json({ error: "Item not found" }, 404);
  return c.json(paste);
});

pasteRoutes.post("/api/pastes", requireUser, async (c) => {
  const body = await readJson<PasteWrite>(c, PASTE_JSON_BODY_BYTES);
  if (!validPasteWrite(body)) return c.json({ error: "Invalid encrypted item" }, 400);

  const outcome = await createPaste(c.env, c.get("userId"), body);
  if (outcome.status === "account-unavailable") {
    return c.json({ error: "Account is unavailable" }, 409);
  }
  if (outcome.status === "quota-reached") {
    return c.json({ error: "Item quota reached. Delete an item before creating another." }, 413);
  }
  return c.json({ id: body.id, createdAt: outcome.createdAt }, 201);
});

pasteRoutes.put("/api/pastes/:id", requireUser, async (c) => {
  const body = await readJson<Omit<PasteWrite, "id">>(c, PASTE_JSON_BODY_BYTES);
  const id = c.req.param("id")!;
  if (!validPasteWrite(body ? { ...body, id } : null)) return c.json({ error: "Invalid encrypted item" }, 400);

  const result = await updatePaste(c.env.DB, id, c.get("userId"), body!);
  if (!result.meta.changes) return c.json({ error: "Item not found" }, 404);
  return c.json({ id });
});

pasteRoutes.delete("/api/pastes/:id", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const ownerId = c.get("userId");
  if (!(await deletePaste(c.env.DB, pasteId, ownerId))) {
    return c.json({ error: "Item not found" }, 404);
  }

  c.executionCtx.waitUntil(
    enqueuePendingDeletions(c.env).catch(() => console.error("Could not dispatch pending ciphertext deletions")),
  );
  return c.body(null, 204);
});

function validPasteWrite(body: PasteWrite | null): body is PasteWrite {
  return Boolean(
    body &&
      OPAQUE_ID.test(body.id) &&
      validOpaque(body.ciphertext, MAX_CIPHERTEXT_LENGTH) &&
      validOpaque(body.contentIv) &&
      validOpaque(body.wrappedKey) &&
      validOpaque(body.wrappedKeyIv) &&
      validExpiry(body.expiresAt),
  );
}

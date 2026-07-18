import { Hono } from "hono";

import type { PasteWrite } from "../../shared/protocol/pastes";
import { MAX_CIPHERTEXT_LENGTH, OPAQUE_ID, serviceLimits } from "../lib/config";
import { throwUniqueConflict } from "../lib/errors";
import { normalizeExpiry, PASTE_JSON_BODY_BYTES, readJson, validExpiry, validOpaque } from "../lib/http";
import {
  findActiveOwnedPaste,
  listActiveOwnedPastes,
  updateActiveOwnedPaste,
} from "../repositories/pastes";
import { enqueuePendingDeletions } from "../services/deletions";
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

  const now = Date.now();
  const userId = c.get("userId");
  let inserted: D1Result;
  try {
    inserted = await c.env.DB.prepare(
      `INSERT INTO pastes (
        id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv,
        created_at, updated_at, expires_at
      )
      SELECT ?, u.id, ?, ?, ?, ?, ?, ?, ?
      FROM users u
      WHERE u.id = ? AND u.deletion_requested_at IS NULL
        AND (SELECT COUNT(*) FROM pastes WHERE owner_id = u.id) < ?`,
    )
      .bind(
        body.id,
        body.ciphertext,
        body.contentIv,
        body.wrappedKey,
        body.wrappedKeyIv,
        now,
        now,
        normalizeExpiry(body.expiresAt),
        userId,
        serviceLimits(c.env).maxPastesPerUser,
      )
      .run();
  } catch (cause) {
    throwUniqueConflict(cause, "Item ID already exists");
  }
  if (!inserted.meta.changes) {
    const active = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND deletion_requested_at IS NULL",
    ).bind(userId).first();
    if (!active) return c.json({ error: "Account is unavailable" }, 409);
    return c.json({ error: "Item quota reached. Delete an item before creating another." }, 413);
  }
  return c.json({ id: body.id, createdAt: now }, 201);
});

pasteRoutes.put("/api/pastes/:id", requireUser, async (c) => {
  const body = await readJson<Omit<PasteWrite, "id">>(c, PASTE_JSON_BODY_BYTES);
  const id = c.req.param("id")!;
  if (!validPasteWrite(body ? { ...body, id } : null)) return c.json({ error: "Invalid encrypted item" }, 400);

  const now = Date.now();
  const result = await updateActiveOwnedPaste(
    c.env.DB,
    id,
    c.get("userId"),
    body!,
    now,
    normalizeExpiry(body!.expiresAt),
  );
  if (!result.meta.changes) return c.json({ error: "Item not found" }, 404);
  return c.json({ id });
});

pasteRoutes.delete("/api/pastes/:id", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const ownerId = c.get("userId");
  const now = Date.now();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO deletion_jobs (
        id, owner_id, object_key, ciphertext_size, created_at, queued_at
      )
      SELECT a.id, p.owner_id, a.object_key, a.ciphertext_size, ?, NULL
      FROM attachments a JOIN pastes p ON p.id = a.paste_id
      WHERE p.id = ? AND p.owner_id = ?`,
    ).bind(now, pasteId, ownerId),
    c.env.DB.prepare("DELETE FROM pastes WHERE id = ? AND owner_id = ?").bind(pasteId, ownerId),
  ]);
  if (!results[1]?.meta.changes) return c.json({ error: "Item not found" }, 404);

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

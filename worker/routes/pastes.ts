import { Hono } from "hono";

import type { StoredPaste } from "../../src/lib/types";
import { MAX_CIPHERTEXT_LENGTH, OPAQUE_ID, serviceLimits } from "../lib/config";
import { normalizeExpiry, readJson, validExpiry, validOpaque } from "../lib/http";
import { enqueuePendingDeletions, stageDeletion } from "../services/deletions";
import { requireUser } from "../services/sessions";
import type { AppContext, AppEnv, PasteWrite } from "../types";

export const pasteRoutes = new Hono<AppEnv>();

pasteRoutes.get("/api/pastes", requireUser, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, ciphertext, content_iv AS contentIv, wrapped_key AS wrappedKey,
      wrapped_key_iv AS wrappedKeyIv, created_at AS createdAt, updated_at AS updatedAt,
      expires_at AS expiresAt, version
     FROM pastes
     WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY updated_at DESC`,
  )
    .bind(c.get("userId"), Date.now())
    .all<StoredPaste>();
  return c.json({ pastes: rows.results });
});

pasteRoutes.get("/api/pastes/:id", requireUser, async (c) => {
  const paste = await getOwnedPaste(c, c.req.param("id")!);
  if (!paste) return c.json({ error: "Item not found" }, 404);
  return c.json(paste);
});

pasteRoutes.post("/api/pastes", requireUser, async (c) => {
  const body = await readJson<PasteWrite>(c);
  if (!validPasteWrite(body)) return c.json({ error: "Invalid encrypted item" }, 400);

  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM pastes WHERE owner_id = ?")
    .bind(c.get("userId"))
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= serviceLimits(c.env).maxPastesPerUser) {
    return c.json({ error: "Item quota reached. Delete an item before creating another." }, 413);
  }

  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO pastes (
        id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        body.id,
        c.get("userId"),
        body.ciphertext,
        body.contentIv,
        body.wrappedKey,
        body.wrappedKeyIv,
        now,
        now,
        normalizeExpiry(body.expiresAt),
      )
      .run();
  } catch {
    return c.json({ error: "Item ID already exists" }, 409);
  }
  return c.json({ id: body.id, createdAt: now }, 201);
});

pasteRoutes.put("/api/pastes/:id", requireUser, async (c) => {
  const body = await readJson<Omit<PasteWrite, "id">>(c);
  const id = c.req.param("id")!;
  if (!validPasteWrite(body ? { ...body, id } : null)) return c.json({ error: "Invalid encrypted item" }, 400);

  const result = await c.env.DB.prepare(
    `UPDATE pastes SET ciphertext = ?, content_iv = ?, wrapped_key = ?, wrapped_key_iv = ?,
      updated_at = ?, expires_at = ?, version = version + 1
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(
      body!.ciphertext,
      body!.contentIv,
      body!.wrappedKey,
      body!.wrappedKeyIv,
      Date.now(),
      normalizeExpiry(body!.expiresAt),
      id,
      c.get("userId"),
    )
    .run();
  if (!result.meta.changes) return c.json({ error: "Item not found" }, 404);
  return c.json({ id });
});

pasteRoutes.delete("/api/pastes/:id", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const ownerId = c.get("userId");
  const paste = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(pasteId, ownerId)
    .first();
  if (!paste) return c.json({ error: "Item not found" }, 404);

  const objects = await c.env.DB.prepare(
    `SELECT a.id, a.object_key AS objectKey, a.ciphertext_size AS ciphertextSize
     FROM attachments a WHERE a.paste_id = ?`,
  )
    .bind(pasteId)
    .all<{ id: string; objectKey: string; ciphertextSize: number }>();

  await c.env.DB.batch([
    ...objects.results.map((item) => stageDeletion(c.env.DB, { ...item, ownerId })),
    c.env.DB.prepare("DELETE FROM pastes WHERE id = ? AND owner_id = ?").bind(pasteId, ownerId),
  ]);
  c.executionCtx.waitUntil(
    enqueuePendingDeletions(c.env).catch(() => console.error("Could not dispatch pending ciphertext deletions")),
  );
  return c.body(null, 204);
});

async function getOwnedPaste(c: AppContext, id: string) {
  return c.env.DB.prepare(
    `SELECT id, ciphertext, content_iv AS contentIv, wrapped_key AS wrappedKey,
      wrapped_key_iv AS wrappedKeyIv, created_at AS createdAt, updated_at AS updatedAt,
      expires_at AS expiresAt, version
     FROM pastes WHERE id = ? AND owner_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(id, c.get("userId"), Date.now())
    .first<StoredPaste>();
}

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

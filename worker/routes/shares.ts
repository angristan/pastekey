import { Hono } from "hono";

import type { StoredShare } from "../../src/lib/types";
import { OPAQUE_ID } from "../lib/config";
import { normalizeExpiry, readJson, validOpaque } from "../lib/http";
import { listAttachments, streamR2Object } from "../repositories/attachments";
import { requireUser } from "../services/sessions";
import type { AppEnv, ShareWrite } from "../types";

export const shareRoutes = new Hono<AppEnv>();

shareRoutes.get("/api/pastes/:id/shares", requireUser, async (c) => {
  const owned = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .first();
  if (!owned) return c.json({ error: "Item not found" }, 404);

  const shares = await c.env.DB.prepare(
    `SELECT id, created_at AS createdAt, expires_at AS expiresAt
     FROM shares WHERE paste_id = ? ORDER BY created_at DESC`,
  )
    .bind(c.req.param("id"))
    .all<{ id: string; createdAt: number; expiresAt: number | null }>();
  return c.json({ shares: shares.results });
});

shareRoutes.post("/api/pastes/:id/shares", requireUser, async (c) => {
  const body = await readJson<ShareWrite>(c);
  if (!body || !OPAQUE_ID.test(body.id) || !validOpaque(body.wrappedKey) || !validOpaque(body.wrappedKeyIv)) {
    return c.json({ error: "Invalid encrypted share" }, 400);
  }

  const paste = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .first();
  if (!paste) return c.json({ error: "Item not found" }, 404);

  const now = Date.now();
  try {
    await c.env.DB.prepare(
      "INSERT INTO shares (id, paste_id, wrapped_key, wrapped_key_iv, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(body.id, c.req.param("id"), body.wrappedKey, body.wrappedKeyIv, now, normalizeExpiry(body.expiresAt))
      .run();
  } catch {
    return c.json({ error: "Share ID already exists" }, 409);
  }
  return c.json({ id: body.id, createdAt: now }, 201);
});

shareRoutes.delete("/api/pastes/:pasteId/shares/:shareId", requireUser, async (c) => {
  const result = await c.env.DB.prepare(
    `DELETE FROM shares WHERE id = ? AND paste_id = ? AND paste_id IN
      (SELECT id FROM pastes WHERE owner_id = ?)`,
  )
    .bind(c.req.param("shareId"), c.req.param("pasteId"), c.get("userId"))
    .run();
  if (!result.meta.changes) return c.json({ error: "Share not found" }, 404);
  return c.body(null, 204);
});

shareRoutes.get("/api/shares/:id", async (c) => {
  const now = Date.now();
  const share = await c.env.DB.prepare(
    `SELECT s.id, s.paste_id AS pasteId, p.ciphertext, p.content_iv AS contentIv,
      s.wrapped_key AS wrappedKey, s.wrapped_key_iv AS wrappedKeyIv,
      s.created_at AS createdAt, p.updated_at AS updatedAt, s.expires_at AS expiresAt
     FROM shares s JOIN pastes p ON p.id = s.paste_id
     JOIN users u ON u.id = p.owner_id
     WHERE s.id = ? AND u.deletion_requested_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > ?)
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
  )
    .bind(c.req.param("id"), now, now)
    .first<Omit<StoredShare, "attachments">>();
  if (!share) return c.json({ error: "Share not found or expired" }, 404);
  return c.json({ ...share, attachments: await listAttachments(c.env.DB, share.pasteId) });
});

shareRoutes.get("/api/shares/:shareId/files/:fileId/content", async (c) => {
  const now = Date.now();
  const attachment = await c.env.DB.prepare(
    `SELECT a.object_key AS objectKey FROM attachments a
     JOIN pastes p ON p.id = a.paste_id
     JOIN users u ON u.id = p.owner_id
     JOIN shares s ON s.paste_id = p.id
     WHERE a.id = ? AND s.id = ? AND u.deletion_requested_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > ?)
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
  )
    .bind(c.req.param("fileId"), c.req.param("shareId"), now, now)
    .first<{ objectKey: string }>();
  if (!attachment) return c.json({ error: "Attachment not found or share expired" }, 404);
  return streamR2Object(c, attachment.objectKey);
});

import { Hono } from "hono";

import type { ShareWrite, StoredShare } from "../../shared/protocol/pastes";
import { OPAQUE_ID } from "../lib/config";
import { throwUniqueConflict } from "../lib/errors";
import { normalizeExpiry, readJson, SMALL_JSON_BODY_BYTES, validOpaque } from "../lib/http";
import { listAttachments, streamR2Object } from "../repositories/attachments";
import { findActiveOwnedPaste } from "../repositories/pastes";
import { requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const shareRoutes = new Hono<AppEnv>();

shareRoutes.get("/api/pastes/:id/shares", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const owned = await findActiveOwnedPaste(c.env.DB, pasteId, c.get("userId"));
  if (!owned) return c.json({ error: "Item not found" }, 404);

  const shares = await c.env.DB.prepare(
    `SELECT id, created_at AS createdAt, expires_at AS expiresAt
     FROM shares WHERE paste_id = ? ORDER BY created_at DESC`,
  )
    .bind(pasteId)
    .all<{ id: string; createdAt: number; expiresAt: number | null }>();
  return c.json({ shares: shares.results });
});

shareRoutes.post("/api/pastes/:id/shares", requireUser, async (c) => {
  const body = await readJson<ShareWrite>(c, SMALL_JSON_BODY_BYTES);
  if (!body || !OPAQUE_ID.test(body.id) || !validOpaque(body.wrappedKey) || !validOpaque(body.wrappedKeyIv)) {
    return c.json({ error: "Invalid encrypted share" }, 400);
  }

  const pasteId = c.req.param("id")!;
  const paste = await findActiveOwnedPaste(c.env.DB, pasteId, c.get("userId"));
  if (!paste) return c.json({ error: "Item not found" }, 404);

  const now = Date.now();
  try {
    await c.env.DB.prepare(
      "INSERT INTO shares (id, paste_id, wrapped_key, wrapped_key_iv, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(body.id, pasteId, body.wrappedKey, body.wrappedKeyIv, now, normalizeExpiry(body.expiresAt))
      .run();
  } catch (cause) {
    throwUniqueConflict(cause, "Share ID already exists");
  }
  return c.json({ id: body.id, createdAt: now }, 201);
});

shareRoutes.delete("/api/pastes/:pasteId/shares/:shareId", requireUser, async (c) => {
  const pasteId = c.req.param("pasteId")!;
  if (!(await findActiveOwnedPaste(c.env.DB, pasteId, c.get("userId")))) {
    return c.json({ error: "Item not found" }, 404);
  }
  const result = await c.env.DB.prepare("DELETE FROM shares WHERE id = ? AND paste_id = ?")
    .bind(c.req.param("shareId"), pasteId)
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

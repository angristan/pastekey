import { Hono } from "hono";

import { OPAQUE_ID, serviceLimits } from "../lib/config";
import {
  listAttachments,
  readAttachmentHeaders,
  streamR2Object,
} from "../repositories/attachments";
import { requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.get("/api/pastes/:id/files", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const paste = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(pasteId, c.get("userId"))
    .first();
  if (!paste) return c.json({ error: "Paste not found" }, 404);
  return c.json({ attachments: await listAttachments(c.env.DB, pasteId) });
});

attachmentRoutes.put("/api/pastes/:pasteId/files/:fileId", requireUser, async (c) => {
  const pasteId = c.req.param("pasteId")!;
  const fileId = c.req.param("fileId")!;
  const userId = c.get("userId");
  const limits = serviceLimits(c.env);
  const length = Number(c.req.header("Content-Length"));

  if (!OPAQUE_ID.test(fileId)) return c.json({ error: "Invalid attachment ID" }, 400);
  if (!Number.isSafeInteger(length) || length <= 16) return c.json({ error: "Content-Length is required" }, 411);
  if (length > limits.maxFileBytes + 16) return c.json({ error: "Encrypted file exceeds the size limit" }, 413);

  const fields = readAttachmentHeaders(c.req.raw.headers);
  if (!fields) return c.json({ error: "Invalid encrypted attachment metadata" }, 400);

  const paste = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(pasteId, userId)
    .first();
  if (!paste) return c.json({ error: "Paste not found" }, 404);

  const existing = await c.env.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(fileId).first();
  if (existing) return c.json({ error: "Attachment ID already exists" }, 409);

  const [fileCount, storage] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM attachments WHERE paste_id = ?")
      .bind(pasteId)
      .first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(a.ciphertext_size), 0) AS bytes FROM attachments a
       JOIN pastes p ON p.id = a.paste_id WHERE p.owner_id = ?`,
    )
      .bind(userId)
      .first<{ bytes: number }>(),
  ]);
  if ((fileCount?.count ?? 0) >= limits.maxFilesPerPaste) {
    return c.json({ error: "Attachment limit reached for this paste" }, 413);
  }
  if ((storage?.bytes ?? 0) + length > limits.maxStorageBytes) {
    return c.json({ error: "Account storage quota exceeded" }, 413);
  }
  if (!c.req.raw.body) return c.json({ error: "Encrypted file body is required" }, 400);

  const objectKey = `${userId}/${pasteId}/${fileId}`;
  await c.env.FILES.put(objectKey, c.req.raw.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO attachments (
        id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
        metadata_ciphertext, metadata_iv, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        fileId,
        pasteId,
        objectKey,
        length,
        fields.contentIv,
        fields.wrappedKey,
        fields.wrappedKeyIv,
        fields.metadataCiphertext,
        fields.metadataIv,
        now,
      )
      .run();
  } catch {
    await c.env.FILES.delete(objectKey);
    return c.json({ error: "Attachment could not be saved" }, 409);
  }

  return c.json({ id: fileId, createdAt: now }, 201);
});

attachmentRoutes.get("/api/pastes/:pasteId/files/:fileId/content", requireUser, async (c) => {
  const attachment = await c.env.DB.prepare(
    `SELECT a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE a.id = ? AND p.id = ? AND p.owner_id = ?`,
  )
    .bind(c.req.param("fileId"), c.req.param("pasteId"), c.get("userId"))
    .first<{ objectKey: string }>();
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);
  return streamR2Object(c, attachment.objectKey);
});

attachmentRoutes.delete("/api/pastes/:pasteId/files/:fileId", requireUser, async (c) => {
  const attachment = await c.env.DB.prepare(
    `SELECT a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE a.id = ? AND p.id = ? AND p.owner_id = ?`,
  )
    .bind(c.req.param("fileId"), c.req.param("pasteId"), c.get("userId"))
    .first<{ objectKey: string }>();
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);

  await c.env.FILES.delete(attachment.objectKey);
  await c.env.DB.prepare("DELETE FROM attachments WHERE id = ? AND paste_id = ?")
    .bind(c.req.param("fileId"), c.req.param("pasteId"))
    .run();
  return c.body(null, 204);
});

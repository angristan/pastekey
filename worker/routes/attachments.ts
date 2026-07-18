import { Hono } from "hono";

import { OPAQUE_ID, serviceLimits } from "../lib/config";
import {
  insertAttachment,
  listAttachments,
  readAttachmentHeaders,
  streamR2Object,
} from "../repositories/attachments";
import { enqueuePendingDeletions, stageDeletion } from "../services/deletions";
import { requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.get("/api/pastes/:id/files", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const paste = await c.env.DB.prepare("SELECT id FROM pastes WHERE id = ? AND owner_id = ?")
    .bind(pasteId, c.get("userId"))
    .first();
  if (!paste) return c.json({ error: "Item not found" }, 404);
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
  if (!paste) return c.json({ error: "Item not found" }, 404);

  const objectKey = `${userId}/${pasteId}/${fileId}`;
  const existing = await c.env.DB.prepare(
    `SELECT id FROM attachments WHERE id = ?
     UNION ALL
     SELECT id FROM deletion_jobs WHERE id = ? OR object_key = ?
     LIMIT 1`,
  )
    .bind(fileId, fileId, objectKey)
    .first();
  if (existing) return c.json({ error: "Attachment ID is already reserved" }, 409);

  const [fileCount, storage] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM attachments WHERE paste_id = ?")
      .bind(pasteId)
      .first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT
        COALESCE((SELECT SUM(a.ciphertext_size) FROM attachments a
          JOIN pastes p ON p.id = a.paste_id WHERE p.owner_id = ?), 0) +
        COALESCE((SELECT SUM(d.ciphertext_size) FROM deletion_jobs d WHERE d.owner_id = ?), 0) AS bytes`,
    )
      .bind(userId, userId)
      .first<{ bytes: number }>(),
  ]);
  if ((fileCount?.count ?? 0) >= limits.maxFilesPerPaste) {
    return c.json({ error: "File limit reached for this item" }, 413);
  }
  if ((storage?.bytes ?? 0) + length > limits.maxStorageBytes) {
    return c.json({ error: "Account storage quota exceeded" }, 413);
  }
  if (!c.req.raw.body) return c.json({ error: "Encrypted file body is required" }, 400);

  await c.env.FILES.put(objectKey, c.req.raw.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  const now = Date.now();
  let inserted: D1Result;
  try {
    inserted = await insertAttachment(c.env.DB, {
      id: fileId,
      pasteId,
      ownerId: userId,
      objectKey,
      ciphertextSize: length,
      contentIv: fields.contentIv,
      wrappedKey: fields.wrappedKey,
      wrappedKeyIv: fields.wrappedKeyIv,
      metadataCiphertext: fields.metadataCiphertext,
      metadataIv: fields.metadataIv,
      createdAt: now,
    });
  } catch {
    await c.env.FILES.delete(objectKey);
    return c.json({ error: "Attachment could not be saved" }, 409);
  }
  if (!inserted.meta.changes) {
    await c.env.FILES.delete(objectKey);
    return c.json({ error: "Item is no longer available" }, 409);
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
  const pasteId = c.req.param("pasteId");
  const fileId = c.req.param("fileId");
  const ownerId = c.get("userId");
  const attachment = await c.env.DB.prepare(
    `SELECT a.id, a.object_key AS objectKey, a.ciphertext_size AS ciphertextSize
     FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE a.id = ? AND p.id = ? AND p.owner_id = ?`,
  )
    .bind(fileId, pasteId, ownerId)
    .first<{ id: string; objectKey: string; ciphertextSize: number }>();
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);

  await c.env.DB.batch([
    stageDeletion(c.env.DB, { ...attachment, ownerId }),
    c.env.DB.prepare("DELETE FROM attachments WHERE id = ? AND paste_id = ?").bind(fileId, pasteId),
  ]);
  c.executionCtx.waitUntil(
    enqueuePendingDeletions(c.env).catch(() => console.error("Could not dispatch pending ciphertext deletions")),
  );
  return c.body(null, 204);
});

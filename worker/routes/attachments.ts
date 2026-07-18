import { Hono } from "hono";

import { OPAQUE_ID, serviceLimits } from "../lib/config";
import {
  finalizeAttachment,
  listAttachments,
  readAttachmentHeaders,
  reserveAttachment,
  stageReservationDeletion,
  streamR2Object,
} from "../repositories/attachments";
import { findActiveOwnedPaste } from "../repositories/pastes";
import { enqueuePendingDeletions, stageDeletion } from "../services/deletions";
import { requireUser } from "../services/sessions";
import type { AppContext, AppEnv } from "../types";

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.get("/api/pastes/:id/files", requireUser, async (c) => {
  const pasteId = c.req.param("id")!;
  const paste = await findActiveOwnedPaste(c.env.DB, pasteId, c.get("userId"));
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

  if (!c.req.raw.body) return c.json({ error: "Encrypted file body is required" }, 400);

  const objectKey = `${userId}/${pasteId}/${fileId}`;
  const reservation = { id: fileId, pasteId, ownerId: userId, objectKey, ciphertextSize: length };
  let reserved: D1Result;
  try {
    reserved = await reserveAttachment(c.env.DB, reservation, limits);
  } catch {
    return c.json({ error: "Attachment ID is already reserved" }, 409);
  }
  if (!reserved.meta.changes) {
    const [paste, identity, fileCount] = await Promise.all([
      c.env.DB.prepare(
        `SELECT p.id FROM pastes p JOIN users u ON u.id = p.owner_id
         WHERE p.id = ? AND p.owner_id = ? AND u.deletion_requested_at IS NULL
           AND (p.expires_at IS NULL OR p.expires_at > ?)`,
      ).bind(pasteId, userId, Date.now()).first(),
      c.env.DB.prepare(
        `SELECT id FROM attachments WHERE id = ? OR object_key = ?
         UNION ALL SELECT id FROM deletion_jobs WHERE id = ? OR object_key = ?
         UNION ALL SELECT id FROM upload_reservations WHERE id = ? OR object_key = ?
         LIMIT 1`,
      ).bind(fileId, objectKey, fileId, objectKey, fileId, objectKey).first(),
      c.env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM attachments WHERE paste_id = ?) +
          (SELECT COUNT(*) FROM upload_reservations WHERE paste_id = ?) AS count`,
      ).bind(pasteId, pasteId).first<{ count: number }>(),
    ]);
    if (!paste) return c.json({ error: "Item not found" }, 404);
    if (identity) return c.json({ error: "Attachment ID is already reserved" }, 409);
    if ((fileCount?.count ?? 0) >= limits.maxFilesPerPaste) {
      return c.json({ error: "File limit reached for this item" }, 413);
    }
    return c.json({ error: "Account storage quota exceeded" }, 413);
  }

  try {
    await c.env.FILES.put(objectKey, c.req.raw.body, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  } catch {
    await cleanupRejectedUpload(c, fileId, objectKey);
    return c.json({ error: "Encrypted attachment upload failed" }, 503);
  }

  const now = Date.now();
  let finalized: D1Result;
  try {
    finalized = await finalizeAttachment(c.env.DB, {
      ...reservation,
      contentIv: fields.contentIv,
      wrappedKey: fields.wrappedKey,
      wrappedKeyIv: fields.wrappedKeyIv,
      metadataCiphertext: fields.metadataCiphertext,
      metadataIv: fields.metadataIv,
      createdAt: now,
    });
  } catch {
    await cleanupRejectedUpload(c, fileId, objectKey);
    return c.json({ error: "Attachment could not be saved" }, 409);
  }
  if (!finalized.meta.changes) {
    await cleanupRejectedUpload(c, fileId, objectKey);
    return c.json({ error: "Item is no longer available" }, 409);
  }

  return c.json({ id: fileId, createdAt: now }, 201);
});

attachmentRoutes.get("/api/pastes/:pasteId/files/:fileId/content", requireUser, async (c) => {
  const pasteId = c.req.param("pasteId")!;
  const ownerId = c.get("userId");
  if (!(await findActiveOwnedPaste(c.env.DB, pasteId, ownerId))) {
    return c.json({ error: "Item not found" }, 404);
  }
  const attachment = await c.env.DB.prepare(
    `SELECT a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE a.id = ? AND p.id = ? AND p.owner_id = ?`,
  )
    .bind(c.req.param("fileId"), pasteId, ownerId)
    .first<{ objectKey: string }>();
  if (!attachment) return c.json({ error: "Attachment not found" }, 404);
  return streamR2Object(c, attachment.objectKey);
});

attachmentRoutes.delete("/api/pastes/:pasteId/files/:fileId", requireUser, async (c) => {
  const pasteId = c.req.param("pasteId")!;
  const fileId = c.req.param("fileId")!;
  const ownerId = c.get("userId");
  if (!(await findActiveOwnedPaste(c.env.DB, pasteId, ownerId))) {
    return c.json({ error: "Item not found" }, 404);
  }
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

async function cleanupRejectedUpload(c: AppContext, reservationId: string, objectKey: string) {
  // A failed or ambiguous R2 PUT may still have committed. Delete directly while the
  // request is alive and retain the durable outbox path for crash recovery.
  await Promise.allSettled([
    c.env.FILES.delete(objectKey),
    stageReservationDeletion(c.env.DB, reservationId),
  ]);
  c.executionCtx.waitUntil(
    enqueuePendingDeletions(c.env).catch(() => console.error("Could not dispatch rejected upload deletion")),
  );
}

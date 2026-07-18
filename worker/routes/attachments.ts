import { Hono } from "hono";

import { OPAQUE_ID, serviceLimits } from "../lib/config";
import { readAttachmentHeaders, streamR2Object } from "../lib/attachments-http";
import { listActiveOwnedAttachments, listAttachments } from "../repositories/attachments";
import { findActiveOwnedPaste } from "../repositories/pastes";
import { uploadAttachment } from "../services/attachment-upload";
import { enqueuePendingDeletions, stageDeletion } from "../services/deletions";
import { requireUser } from "../services/sessions";
import type { AppEnv } from "../types";

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.get("/api/attachments", requireUser, async (c) => {
  const attachments = await listActiveOwnedAttachments(c.env.DB, c.get("userId"));
  return c.json({ attachments });
});

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

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Encrypted file body is required" }, 400);

  const objectKey = `${userId}/${pasteId}/${fileId}`;
  const outcome = await uploadAttachment(c.env, {
    pasteId,
    fileId,
    ownerId: userId,
    objectKey,
    ciphertextSize: length,
    body,
    headers: fields,
    limits,
  }, (promise) => c.executionCtx.waitUntil(promise));

  switch (outcome.status) {
    case "created":
      return c.json({ id: fileId, createdAt: outcome.createdAt }, 201);
    case "item-not-found":
      return c.json({ error: "Item not found" }, 404);
    case "identity-conflict":
      return c.json({ error: "Attachment ID is already reserved" }, 409);
    case "file-limit":
      return c.json({ error: "File limit reached for this item" }, 413);
    case "storage-limit":
      return c.json({ error: "Account storage quota exceeded" }, 413);
    case "item-unavailable":
      return c.json({ error: "Item is no longer available" }, 409);
  }
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
  return streamR2Object(c.env.FILES, attachment.objectKey);
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

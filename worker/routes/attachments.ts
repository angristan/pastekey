import { Effect } from "effect";
import { Hono } from "hono";

import { OPAQUE_ID, serviceLimits } from "../lib/config";
import { ApiHttpError } from "../lib/errors";
import { readAttachmentHeaders, streamAttachmentObject } from "../lib/attachments-http";
import { listActiveOwnedAttachments } from "../repositories/attachments";
import { runWorkerEffect } from "../runtime";
import {
  deleteOwnedAttachment,
  dispatchPendingAttachmentDeletions,
  listAttachmentsForPaste,
  openOwnedAttachment,
  uploadAttachment,
} from "../services/attachment-upload";
import { requireUser } from "../services/sessions";
import type { AppContext, AppEnv } from "../types";

export const attachmentRoutes = new Hono<AppEnv>();

const deferDeletionDispatch = (c: AppContext) => {
  c.executionCtx.waitUntil(
    runWorkerEffect(
      c.env,
      dispatchPendingAttachmentDeletions().pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            console.error("Could not dispatch pending ciphertext deletions");
          })
        ),
      ),
    ),
  );
};

attachmentRoutes.get("/api/attachments", requireUser, async (c) => {
  const attachments = await runWorkerEffect(
    c.env,
    listActiveOwnedAttachments(c.get("userId")),
  );
  return c.json({ attachments });
});

attachmentRoutes.get("/api/pastes/:id/files", requireUser, async (c) => {
  const attachments = await runWorkerEffect(
    c.env,
    listAttachmentsForPaste(c.req.param("id")!, c.get("userId")),
  );
  if (attachments === null) return c.json({ error: "Item not found" }, 404);
  return c.json({ attachments });
});

attachmentRoutes.put("/api/pastes/:pasteId/files/:fileId", requireUser, async (c) => {
  const pasteId = c.req.param("pasteId")!;
  const fileId = c.req.param("fileId")!;
  const userId = c.get("userId");
  const limits = serviceLimits(c.env);
  const length = Number(c.req.header("Content-Length"));

  if (!OPAQUE_ID.test(fileId)) return c.json({ error: "Invalid attachment ID" }, 400);
  if (!Number.isSafeInteger(length) || length <= 16) {
    return c.json({ error: "Content-Length is required" }, 411);
  }
  if (length > limits.maxFileBytes + 16) {
    return c.json({ error: "Encrypted file exceeds the size limit" }, 413);
  }

  const fields = readAttachmentHeaders(c.req.raw.headers);
  if (fields === null) return c.json({ error: "Invalid encrypted attachment metadata" }, 400);

  const body = c.req.raw.body;
  if (body === null) return c.json({ error: "Encrypted file body is required" }, 400);

  const objectKey = `${userId}/${pasteId}/${fileId}`;
  const outcome = await runWorkerEffect(
    c.env,
    uploadAttachment(
      {
        pasteId,
        fileId,
        ownerId: userId,
        objectKey,
        ciphertextSize: length,
        body,
        headers: fields,
        limits,
      },
      () => deferDeletionDispatch(c),
    ).pipe(
      Effect.catchTags({
        DomainConflictError: (error) =>
          Effect.fail(new ApiHttpError(409, error.message, { cause: error.cause })),
        DomainUnavailableError: (error) =>
          Effect.fail(new ApiHttpError(503, error.message, {
            cause: error.cause,
            report: true,
          })),
      }),
    ),
    {
      name: "pastekey.attachment.upload",
      trigger: "http",
    },
  );

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
  const outcome = await runWorkerEffect(
    c.env,
    openOwnedAttachment(
      c.req.param("pasteId")!,
      c.req.param("fileId")!,
      c.get("userId"),
    ),
  );
  if (outcome.status === "item-not-found") {
    return c.json({ error: "Item not found" }, 404);
  }
  if (outcome.status === "attachment-not-found") {
    return c.json({ error: "Attachment not found" }, 404);
  }
  return runWorkerEffect(c.env, streamAttachmentObject(outcome.value.objectKey));
});

attachmentRoutes.delete("/api/pastes/:pasteId/files/:fileId", requireUser, async (c) => {
  const outcome = await runWorkerEffect(
    c.env,
    deleteOwnedAttachment(
      c.req.param("pasteId")!,
      c.req.param("fileId")!,
      c.get("userId"),
    ),
  );
  if (outcome.status === "item-not-found") {
    return c.json({ error: "Item not found" }, 404);
  }
  if (outcome.status === "attachment-not-found") {
    return c.json({ error: "Attachment not found" }, 404);
  }

  deferDeletionDispatch(c);
  return c.body(null, 204);
});

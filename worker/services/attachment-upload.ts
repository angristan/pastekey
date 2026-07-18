import type { AttachmentHeaders } from "../lib/attachments-http";
import { serviceUnavailable, throwUniqueConflict } from "../lib/errors";
import {
  finalizeAttachment,
  reserveAttachment,
  stageReservationDeletion,
} from "../repositories/attachments";
import type { Bindings } from "../types";
import { enqueuePendingDeletions } from "./deletions";

export type AttachmentUploadOutcome =
  | { status: "created"; createdAt: number }
  | { status: "item-not-found" }
  | { status: "identity-conflict" }
  | { status: "file-limit" }
  | { status: "storage-limit" }
  | { status: "item-unavailable" };

export async function uploadAttachment(
  env: Bindings,
  input: {
    pasteId: string;
    fileId: string;
    ownerId: string;
    objectKey: string;
    ciphertextSize: number;
    body: ReadableStream;
    headers: AttachmentHeaders;
    limits: { maxFilesPerPaste: number; maxStorageBytes: number };
  },
  defer: (promise: Promise<unknown>) => void,
): Promise<AttachmentUploadOutcome> {
  const reservation = {
    id: input.fileId,
    pasteId: input.pasteId,
    ownerId: input.ownerId,
    objectKey: input.objectKey,
    ciphertextSize: input.ciphertextSize,
  };
  let reserved: D1Result;
  try {
    reserved = await reserveAttachment(env.DB, reservation, input.limits);
  } catch (cause) {
    throwUniqueConflict(cause, "Attachment ID is already reserved");
  }
  if (!reserved.meta.changes) return diagnoseReservationFailure(env.DB, input);

  try {
    await env.FILES.put(input.objectKey, input.body, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  } catch (cause) {
    await cleanupRejectedUpload(env, input.fileId, input.objectKey, defer);
    throw serviceUnavailable("Encrypted attachment upload failed", cause);
  }

  const now = Date.now();
  let finalized: D1Result;
  try {
    finalized = await finalizeAttachment(env.DB, {
      ...reservation,
      contentIv: input.headers.contentIv,
      wrappedKey: input.headers.wrappedKey,
      wrappedKeyIv: input.headers.wrappedKeyIv,
      metadataCiphertext: input.headers.metadataCiphertext,
      metadataIv: input.headers.metadataIv,
      createdAt: now,
    });
  } catch (cause) {
    await cleanupRejectedUpload(env, input.fileId, input.objectKey, defer);
    throwUniqueConflict(cause, "Attachment could not be saved");
  }
  if (!finalized.meta.changes) {
    await cleanupRejectedUpload(env, input.fileId, input.objectKey, defer);
    return { status: "item-unavailable" };
  }
  return { status: "created", createdAt: now };
}

async function diagnoseReservationFailure(
  db: D1Database,
  input: {
    pasteId: string;
    fileId: string;
    ownerId: string;
    objectKey: string;
    limits: { maxFilesPerPaste: number };
  },
): Promise<AttachmentUploadOutcome> {
  const [paste, identity, fileCount] = await Promise.all([
    db.prepare(
      `SELECT p.id FROM pastes p JOIN users u ON u.id = p.owner_id
       WHERE p.id = ? AND p.owner_id = ? AND u.deletion_requested_at IS NULL
         AND (p.expires_at IS NULL OR p.expires_at > ?)`,
    ).bind(input.pasteId, input.ownerId, Date.now()).first(),
    db.prepare(
      `SELECT id FROM attachments WHERE id = ? OR object_key = ?
       UNION ALL SELECT id FROM deletion_jobs WHERE id = ? OR object_key = ?
       UNION ALL SELECT id FROM upload_reservations WHERE id = ? OR object_key = ?
       LIMIT 1`,
    ).bind(
      input.fileId,
      input.objectKey,
      input.fileId,
      input.objectKey,
      input.fileId,
      input.objectKey,
    ).first(),
    db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM attachments WHERE paste_id = ?) +
        (SELECT COUNT(*) FROM upload_reservations WHERE paste_id = ?) AS count`,
    ).bind(input.pasteId, input.pasteId).first<{ count: number }>(),
  ]);
  if (!paste) return { status: "item-not-found" };
  if (identity) return { status: "identity-conflict" };
  if ((fileCount?.count ?? 0) >= input.limits.maxFilesPerPaste) return { status: "file-limit" };
  return { status: "storage-limit" };
}

async function cleanupRejectedUpload(
  env: Bindings,
  reservationId: string,
  objectKey: string,
  defer: (promise: Promise<unknown>) => void,
) {
  await Promise.allSettled([
    env.FILES.delete(objectKey),
    stageReservationDeletion(env.DB, reservationId),
  ]);
  defer(enqueuePendingDeletions(env).catch(() => {
    console.error("Could not dispatch rejected upload deletion");
  }));
}

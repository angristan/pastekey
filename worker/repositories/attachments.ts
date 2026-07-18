import type { StoredAttachment } from "../../shared/protocol/attachments";
import { validOpaque } from "../lib/http";
import type { AppContext } from "../types";

export const UPLOAD_RESERVATION_TTL_MS = 2 * 60 * 60 * 1_000;

export type AttachmentReservation = {
  id: string;
  pasteId: string;
  ownerId: string;
  objectKey: string;
  ciphertextSize: number;
};

export type AttachmentInsert = AttachmentReservation & {
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  metadataCiphertext: string;
  metadataIv: string;
  createdAt: number;
};

export async function reserveAttachment(
  db: D1Database,
  reservation: AttachmentReservation,
  limits: { maxFilesPerPaste: number; maxStorageBytes: number },
  now = Date.now(),
) {
  return db.prepare(
    `INSERT INTO upload_reservations (
      id, owner_id, paste_id, object_key, ciphertext_size, created_at, expires_at
    )
    SELECT ?, u.id, p.id, ?, ?, ?, ?
    FROM users u JOIN pastes p ON p.owner_id = u.id
    WHERE u.id = ? AND p.id = ? AND u.deletion_requested_at IS NULL
      AND (p.expires_at IS NULL OR p.expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM attachments WHERE id = ? OR object_key = ?)
      AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE id = ? OR object_key = ?)
      AND NOT EXISTS (SELECT 1 FROM upload_reservations WHERE id = ? OR object_key = ?)
      AND (
        (SELECT COUNT(*) FROM attachments WHERE paste_id = p.id) +
        (SELECT COUNT(*) FROM upload_reservations WHERE paste_id = p.id)
      ) < ?
      AND (
        COALESCE((SELECT SUM(a.ciphertext_size) FROM attachments a
          JOIN pastes owned ON owned.id = a.paste_id WHERE owned.owner_id = u.id), 0) +
        COALESCE((SELECT SUM(ciphertext_size) FROM deletion_jobs WHERE owner_id = u.id), 0) +
        COALESCE((SELECT SUM(ciphertext_size) FROM upload_reservations WHERE owner_id = u.id), 0) + ?
      ) <= ?`,
  )
    .bind(
      reservation.id,
      reservation.objectKey,
      reservation.ciphertextSize,
      now,
      now + UPLOAD_RESERVATION_TTL_MS,
      reservation.ownerId,
      reservation.pasteId,
      now,
      reservation.id,
      reservation.objectKey,
      reservation.id,
      reservation.objectKey,
      reservation.id,
      reservation.objectKey,
      limits.maxFilesPerPaste,
      reservation.ciphertextSize,
      limits.maxStorageBytes,
    )
    .run();
}

export async function finalizeAttachment(db: D1Database, attachment: AttachmentInsert) {
  const results = await db.batch([
    db.prepare(
      `INSERT INTO attachments (
        id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
        metadata_ciphertext, metadata_iv, created_at
      )
      SELECT r.id, r.paste_id, r.object_key, r.ciphertext_size, ?, ?, ?, ?, ?, ?
      FROM upload_reservations r
      JOIN pastes p ON p.id = r.paste_id AND p.owner_id = r.owner_id
      JOIN users u ON u.id = r.owner_id
      WHERE r.id = ? AND r.owner_id = ? AND r.paste_id = ?
        AND r.object_key = ? AND r.ciphertext_size = ?
        AND u.deletion_requested_at IS NULL
        AND (p.expires_at IS NULL OR p.expires_at > ?)`,
    ).bind(
      attachment.contentIv,
      attachment.wrappedKey,
      attachment.wrappedKeyIv,
      attachment.metadataCiphertext,
      attachment.metadataIv,
      attachment.createdAt,
      attachment.id,
      attachment.ownerId,
      attachment.pasteId,
      attachment.objectKey,
      attachment.ciphertextSize,
      attachment.createdAt,
    ),
    db.prepare(
      `DELETE FROM upload_reservations WHERE id = ?
       AND EXISTS (SELECT 1 FROM attachments a
         WHERE a.id = upload_reservations.id
           AND a.object_key = upload_reservations.object_key)`,
    ).bind(attachment.id),
  ]);
  return results[0]!;
}

export async function stageReservationDeletion(db: D1Database, id: string, now = Date.now()) {
  return db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO deletion_jobs (
        id, owner_id, object_key, ciphertext_size, created_at, queued_at
      )
      SELECT id, owner_id, object_key, ciphertext_size, ?, NULL
      FROM upload_reservations WHERE id = ?`,
    ).bind(now, id),
    db.prepare(
      `DELETE FROM upload_reservations WHERE id = ?
       AND EXISTS (SELECT 1 FROM deletion_jobs d
         WHERE d.id = upload_reservations.id
           AND d.object_key = upload_reservations.object_key)`,
    ).bind(id),
  ]);
}

export async function listAttachments(db: D1Database, pasteId: string) {
  const rows = await db.prepare(
    `SELECT id, paste_id AS pasteId, ciphertext_size AS ciphertextSize, content_iv AS contentIv,
      wrapped_key AS wrappedKey, wrapped_key_iv AS wrappedKeyIv,
      metadata_ciphertext AS metadataCiphertext, metadata_iv AS metadataIv, created_at AS createdAt
     FROM attachments WHERE paste_id = ? ORDER BY created_at`,
  )
    .bind(pasteId)
    .all<StoredAttachment>();
  return rows.results;
}

export function readAttachmentHeaders(headers: Headers) {
  const fields = {
    contentIv: headers.get("X-Pastekey-Content-IV"),
    wrappedKey: headers.get("X-Pastekey-Wrapped-Key"),
    wrappedKeyIv: headers.get("X-Pastekey-Wrapped-Key-IV"),
    metadataCiphertext: headers.get("X-Pastekey-Metadata"),
    metadataIv: headers.get("X-Pastekey-Metadata-IV"),
  };
  if (
    !validOpaque(fields.contentIv) ||
    !validOpaque(fields.wrappedKey) ||
    !validOpaque(fields.wrappedKeyIv) ||
    !validOpaque(fields.metadataCiphertext, 20_000) ||
    !validOpaque(fields.metadataIv)
  ) {
    return null;
  }
  return fields as Record<keyof typeof fields, string>;
}

export async function streamR2Object(c: AppContext, objectKey: string) {
  const object = await c.env.FILES.get(objectKey);
  if (!object) return c.json({ error: "Encrypted attachment data not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Length": String(object.size),
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

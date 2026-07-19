import { Effect, Schema } from "effect";

import { StoredAttachment } from "../../shared/schema/attachments";
import { D1 } from "../platform/d1";

export const UPLOAD_RESERVATION_TTL_MS = 2 * 60 * 60 * 1_000;

export type AttachmentReservation = {
  readonly id: string;
  readonly pasteId: string;
  readonly ownerId: string;
  readonly objectKey: string;
  readonly ciphertextSize: number;
};

export type AttachmentInsert = AttachmentReservation & {
  readonly contentIv: string;
  readonly wrappedKey: string;
  readonly wrappedKeyIv: string;
  readonly metadataCiphertext: string;
  readonly metadataIv: string;
  readonly createdAt: number;
};

const CreatedAtRow = Schema.Struct({ createdAt: Schema.Number });
const IdRow = Schema.Struct({ id: Schema.String });
const CountRow = Schema.Struct({ count: Schema.Number });
const AttachmentObjectRow = Schema.Struct({ objectKey: Schema.String });
const AttachmentDeletionRow = Schema.Struct({
  id: Schema.String,
  objectKey: Schema.String,
  ciphertextSize: Schema.Number,
});
const PendingDeletionRow = Schema.Struct({
  id: Schema.String,
  cycle: Schema.Number,
});

export const reserveAttachment = Effect.fn("AttachmentsRepository.reserveAttachment")(
  function* (
    reservation: AttachmentReservation,
    limits: { readonly maxFilesPerPaste: number; readonly maxStorageBytes: number },
    now = Date.now(),
  ) {
    const d1 = yield* D1;
    return yield* d1.run(
      d1.bind(
        d1.prepare(
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
        ),
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
      ),
    );
  },
);

export const finalizeAttachment = Effect.fn("AttachmentsRepository.finalizeAttachment")(
  function* (attachment: AttachmentInsert) {
    const d1 = yield* D1;
    const results = yield* d1.batch([
      d1.bind(
        d1.prepare(
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
        ),
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
      d1.bind(
        d1.prepare(
          `DELETE FROM upload_reservations WHERE id = ?
       AND EXISTS (SELECT 1 FROM attachments a
         WHERE a.id = upload_reservations.id
           AND a.object_key = upload_reservations.object_key)`,
        ),
        attachment.id,
      ),
    ]);
    return results[0];
  },
);

export const findFinalizedAttachment = Effect.fn("AttachmentsRepository.findFinalizedAttachment")(
  function* (attachment: AttachmentInsert) {
    const d1 = yield* D1;
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT created_at AS createdAt FROM attachments
     WHERE id = ? AND paste_id = ? AND object_key = ? AND ciphertext_size = ?
       AND content_iv = ? AND wrapped_key = ? AND wrapped_key_iv = ?
       AND metadata_ciphertext = ? AND metadata_iv = ?`,
        ),
        attachment.id,
        attachment.pasteId,
        attachment.objectKey,
        attachment.ciphertextSize,
        attachment.contentIv,
        attachment.wrappedKey,
        attachment.wrappedKeyIv,
        attachment.metadataCiphertext,
        attachment.metadataIv,
      ),
      CreatedAtRow,
    );
  },
);

export const stageReservationDeletion = Effect.fn("AttachmentsRepository.stageReservationDeletion")(
  function* (id: string, now = Date.now()) {
    const d1 = yield* D1;
    return yield* d1.batch([
      d1.bind(
        d1.prepare(
          `INSERT OR IGNORE INTO deletion_jobs (
        id, owner_id, object_key, ciphertext_size, created_at, queued_at
      )
      SELECT id, owner_id, object_key, ciphertext_size, ?, NULL
      FROM upload_reservations WHERE id = ?`,
        ),
        now,
        id,
      ),
      d1.bind(
        d1.prepare(
          `DELETE FROM upload_reservations WHERE id = ?
       AND EXISTS (SELECT 1 FROM deletion_jobs d
         WHERE d.id = upload_reservations.id
           AND d.object_key = upload_reservations.object_key)`,
        ),
        id,
      ),
    ]);
  },
);

export const listActiveOwnedAttachments = Effect.fn("AttachmentsRepository.listActiveOwnedAttachments")(
  function* (ownerId: string, now = Date.now()) {
    const d1 = yield* D1;
    const rows = yield* d1.all(
      d1.bind(
        d1.prepare(
          `SELECT a.id, a.paste_id AS pasteId, a.ciphertext_size AS ciphertextSize,
      a.content_iv AS contentIv, a.wrapped_key AS wrappedKey, a.wrapped_key_iv AS wrappedKeyIv,
      a.metadata_ciphertext AS metadataCiphertext, a.metadata_iv AS metadataIv, a.created_at AS createdAt
     FROM attachments a
     JOIN pastes p ON p.id = a.paste_id
     JOIN users u ON u.id = p.owner_id
     WHERE p.owner_id = ? AND u.deletion_requested_at IS NULL
       AND (p.expires_at IS NULL OR p.expires_at > ?)
     ORDER BY a.paste_id, a.created_at`,
        ),
        ownerId,
        now,
      ),
      StoredAttachment,
    );
    return rows.results;
  },
);

export const listAttachments = Effect.fn("AttachmentsRepository.listAttachments")(
  function* (pasteId: string) {
    const d1 = yield* D1;
    const rows = yield* d1.all(
      d1.bind(
        d1.prepare(
          `SELECT id, paste_id AS pasteId, ciphertext_size AS ciphertextSize, content_iv AS contentIv,
      wrapped_key AS wrappedKey, wrapped_key_iv AS wrappedKeyIv,
      metadata_ciphertext AS metadataCiphertext, metadata_iv AS metadataIv, created_at AS createdAt
     FROM attachments WHERE paste_id = ? ORDER BY created_at`,
        ),
        pasteId,
      ),
      StoredAttachment,
    );
    return rows.results;
  },
);

export const findOwnedAttachmentObject = Effect.fn("AttachmentsRepository.findOwnedAttachmentObject")(
  function* (fileId: string, pasteId: string, ownerId: string) {
    const d1 = yield* D1;
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE a.id = ? AND p.id = ? AND p.owner_id = ?`,
        ),
        fileId,
        pasteId,
        ownerId,
      ),
      AttachmentObjectRow,
    );
  },
);

export const findOwnedAttachmentDeletion = Effect.fn("AttachmentsRepository.findOwnedAttachmentDeletion")(
  function* (fileId: string, pasteId: string, ownerId: string) {
    const d1 = yield* D1;
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT a.id, a.object_key AS objectKey, a.ciphertext_size AS ciphertextSize
     FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE a.id = ? AND p.id = ? AND p.owner_id = ?`,
        ),
        fileId,
        pasteId,
        ownerId,
      ),
      AttachmentDeletionRow,
    );
  },
);

export const stageAttachmentDeletion = Effect.fn("AttachmentsRepository.stageAttachmentDeletion")(
  function* (
    attachment: { readonly id: string; readonly objectKey: string; readonly ciphertextSize: number },
    pasteId: string,
    ownerId: string,
    now = Date.now(),
  ) {
    const d1 = yield* D1;
    return yield* d1.batch([
      d1.bind(
        d1.prepare(
          `INSERT OR IGNORE INTO deletion_jobs (
      id, owner_id, object_key, ciphertext_size, created_at, queued_at
    ) VALUES (?, ?, ?, ?, ?, NULL)`,
        ),
        attachment.id,
        ownerId,
        attachment.objectKey,
        attachment.ciphertextSize,
        now,
      ),
      d1.bind(
        d1.prepare("DELETE FROM attachments WHERE id = ? AND paste_id = ?"),
        attachment.id,
        pasteId,
      ),
    ]);
  },
);

export const findActivePasteIdentity = Effect.fn("AttachmentsRepository.findActivePasteIdentity")(
  function* (pasteId: string, ownerId: string, now = Date.now()) {
    const d1 = yield* D1;
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT p.id FROM pastes p JOIN users u ON u.id = p.owner_id
       WHERE p.id = ? AND p.owner_id = ? AND u.deletion_requested_at IS NULL
         AND (p.expires_at IS NULL OR p.expires_at > ?)`,
        ),
        pasteId,
        ownerId,
        now,
      ),
      IdRow,
    );
  },
);

export const findAttachmentIdentity = Effect.fn("AttachmentsRepository.findAttachmentIdentity")(
  function* (fileId: string, objectKey: string) {
    const d1 = yield* D1;
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT id FROM attachments WHERE id = ? OR object_key = ?
       UNION ALL SELECT id FROM deletion_jobs WHERE id = ? OR object_key = ?
       UNION ALL SELECT id FROM upload_reservations WHERE id = ? OR object_key = ?
       LIMIT 1`,
        ),
        fileId,
        objectKey,
        fileId,
        objectKey,
        fileId,
        objectKey,
      ),
      IdRow,
    );
  },
);

export const countPasteAttachmentsAndReservations = Effect.fn(
  "AttachmentsRepository.countPasteAttachmentsAndReservations",
)(function* (pasteId: string) {
  const d1 = yield* D1;
  return yield* d1.first(
    d1.bind(
      d1.prepare(
        `SELECT
        (SELECT COUNT(*) FROM attachments WHERE paste_id = ?) +
        (SELECT COUNT(*) FROM upload_reservations WHERE paste_id = ?) AS count`,
      ),
      pasteId,
      pasteId,
    ),
    CountRow,
  );
});

export const listPendingDeletions = Effect.fn("AttachmentsRepository.listPendingDeletions")(
  function* (now: number, limit: number) {
    const d1 = yield* D1;
    const pending = yield* d1.all(
      d1.bind(
        d1.prepare(
          `SELECT id, failure_cycles AS cycle FROM deletion_jobs
     WHERE queued_at IS NULL AND next_attempt_at <= ?
     ORDER BY next_attempt_at, created_at LIMIT ?`,
        ),
        now,
        limit,
      ),
      PendingDeletionRow,
    );
    return pending.results;
  },
);

export const markDeletionsQueued = Effect.fn("AttachmentsRepository.markDeletionsQueued")(
  function* (
    pending: ReadonlyArray<{ readonly id: string; readonly cycle: number }>,
    queuedAt: number,
  ) {
    const d1 = yield* D1;
    return yield* d1.batch(
      pending.map(({ id, cycle }) =>
        d1.bind(
          d1.prepare(
            `UPDATE deletion_jobs SET queued_at = ?
         WHERE id = ? AND failure_cycles = ? AND queued_at IS NULL`,
          ),
          queuedAt,
          id,
          cycle,
        )
      ),
    );
  },
);

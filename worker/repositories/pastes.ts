import { Effect, Schema } from "effect";

import { StoredAttachment } from "../../shared/schema/attachments";
import { StoredPaste } from "../../shared/schema/pastes";
import { Base64Url, OpaqueId, Timestamp } from "../../shared/schema/primitives";
import type { PasteWrite } from "../../shared/protocol/pastes";
import { D1 } from "../platform/d1";

const NullableTimestamp = Schema.Union([Timestamp, Schema.Null]);

class ShareSummaryRow extends Schema.Class<ShareSummaryRow>("ShareSummaryRow")({
  id: OpaqueId,
  createdAt: Timestamp,
  expiresAt: NullableTimestamp,
}) {}

class ActiveShareRow extends Schema.Class<ActiveShareRow>("ActiveShareRow")({
  id: OpaqueId,
  pasteId: OpaqueId,
  ciphertext: Base64Url,
  contentIv: Base64Url,
  wrappedKey: Base64Url,
  wrappedKeyIv: Base64Url,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: NullableTimestamp,
}) {}

class ShareAttachmentRow extends Schema.Class<ShareAttachmentRow>("ShareAttachmentRow")({
  objectKey: Schema.String,
}) {}

export const listActiveOwnedPastes = Effect.fn("PastesRepository.listActiveOwnedPastes")(
  function* (ownerId: string, now = Date.now()) {
    const d1 = yield* D1;
    const rows = yield* d1.all(
      d1.bind(
        d1.prepare(
          `SELECT p.id, p.ciphertext, p.content_iv AS contentIv, p.wrapped_key AS wrappedKey,
      p.wrapped_key_iv AS wrappedKeyIv, p.created_at AS createdAt, p.updated_at AS updatedAt,
      p.expires_at AS expiresAt, p.version
     FROM pastes p JOIN users u ON u.id = p.owner_id
     WHERE p.owner_id = ? AND u.deletion_requested_at IS NULL
       AND (p.expires_at IS NULL OR p.expires_at > ?)
     ORDER BY p.updated_at DESC`,
        ),
        ownerId,
        now,
      ),
      StoredPaste,
    );
    return rows.results;
  },
);

export const findActiveOwnedPaste = Effect.fn("PastesRepository.findActiveOwnedPaste")(
  function* (pasteId: string, ownerId: string, now = Date.now()) {
    const d1 = yield* D1;
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT p.id, p.ciphertext, p.content_iv AS contentIv, p.wrapped_key AS wrappedKey,
      p.wrapped_key_iv AS wrappedKeyIv, p.created_at AS createdAt, p.updated_at AS updatedAt,
      p.expires_at AS expiresAt, p.version
     FROM pastes p JOIN users u ON u.id = p.owner_id
     WHERE p.id = ? AND p.owner_id = ? AND u.deletion_requested_at IS NULL
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
        ),
        pasteId,
        ownerId,
        now,
      ),
      StoredPaste,
    );
  },
);

export const updateActiveOwnedPaste = Effect.fn("PastesRepository.updateActiveOwnedPaste")(
  function* (
    pasteId: string,
    ownerId: string,
    write: Omit<PasteWrite, "id">,
    updatedAt: number,
    expiresAt: number | null,
  ) {
    const d1 = yield* D1;
    return yield* d1.run(
      d1.bind(
        d1.prepare(
          `UPDATE pastes AS p SET ciphertext = ?, content_iv = ?, wrapped_key = ?, wrapped_key_iv = ?,
      updated_at = ?, expires_at = ?, version = version + 1
     WHERE p.id = ? AND p.owner_id = ?
       AND (p.expires_at IS NULL OR p.expires_at > ?)
       AND EXISTS (
         SELECT 1 FROM users u WHERE u.id = p.owner_id AND u.deletion_requested_at IS NULL
       )`,
        ),
        write.ciphertext,
        write.contentIv,
        write.wrappedKey,
        write.wrappedKeyIv,
        updatedAt,
        expiresAt,
        pasteId,
        ownerId,
        updatedAt,
      ),
    );
  },
);

export const listPasteShares = Effect.fn("PastesRepository.listPasteShares")(
  function* (pasteId: string) {
    const d1 = yield* D1;
    const shares = yield* d1.all(
      d1.bind(
        d1.prepare(
          `SELECT id, created_at AS createdAt, expires_at AS expiresAt
     FROM shares WHERE paste_id = ? ORDER BY created_at DESC`,
        ),
        pasteId,
      ),
      ShareSummaryRow,
    );
    return shares.results;
  },
);

export const insertShare = Effect.fn("PastesRepository.insertShare")(
  function* (
    pasteId: string,
    id: string,
    wrappedKey: string,
    wrappedKeyIv: string,
    createdAt: number,
    expiresAt: number | null,
  ) {
    const d1 = yield* D1;
    return yield* d1.run(
      d1.bind(
        d1.prepare(
          "INSERT INTO shares (id, paste_id, wrapped_key, wrapped_key_iv, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        ),
        id,
        pasteId,
        wrappedKey,
        wrappedKeyIv,
        createdAt,
        expiresAt,
      ),
    );
  },
);

export const deletePasteShare = Effect.fn("PastesRepository.deletePasteShare")(
  function* (shareId: string, pasteId: string) {
    const d1 = yield* D1;
    return yield* d1.run(
      d1.bind(
        d1.prepare("DELETE FROM shares WHERE id = ? AND paste_id = ?"),
        shareId,
        pasteId,
      ),
    );
  },
);

export const findActiveShare = Effect.fn("PastesRepository.findActiveShare")(
  function* (shareId: string, now = Date.now()) {
    const d1 = yield* D1;
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT s.id, s.paste_id AS pasteId, p.ciphertext, p.content_iv AS contentIv,
      s.wrapped_key AS wrappedKey, s.wrapped_key_iv AS wrappedKeyIv,
      s.created_at AS createdAt, p.updated_at AS updatedAt, s.expires_at AS expiresAt
     FROM shares s JOIN pastes p ON p.id = s.paste_id
     JOIN users u ON u.id = p.owner_id
     WHERE s.id = ? AND u.deletion_requested_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > ?)
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
        ),
        shareId,
        now,
        now,
      ),
      ActiveShareRow,
    );
  },
);

export const listPasteAttachments = Effect.fn("PastesRepository.listPasteAttachments")(
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

export const findActiveShareAttachment = Effect.fn("PastesRepository.findActiveShareAttachment")(
  function* (fileId: string, shareId: string, now = Date.now()) {
    const d1 = yield* D1;
    return yield* d1.first(
      d1.bind(
        d1.prepare(
          `SELECT a.object_key AS objectKey FROM attachments a
     JOIN pastes p ON p.id = a.paste_id
     JOIN users u ON u.id = p.owner_id
     JOIN shares s ON s.paste_id = p.id
     WHERE a.id = ? AND s.id = ? AND u.deletion_requested_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > ?)
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
        ),
        fileId,
        shareId,
        now,
        now,
      ),
      ShareAttachmentRow,
    );
  },
);

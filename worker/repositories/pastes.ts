import type { StoredPaste, PasteWrite } from "../../shared/protocol/pastes";

export function listActiveOwnedPastes(db: D1Database, ownerId: string, now = Date.now()) {
  return db.prepare(
    `SELECT p.id, p.ciphertext, p.content_iv AS contentIv, p.wrapped_key AS wrappedKey,
      p.wrapped_key_iv AS wrappedKeyIv, p.created_at AS createdAt, p.updated_at AS updatedAt,
      p.expires_at AS expiresAt, p.version
     FROM pastes p JOIN users u ON u.id = p.owner_id
     WHERE p.owner_id = ? AND u.deletion_requested_at IS NULL
       AND (p.expires_at IS NULL OR p.expires_at > ?)
     ORDER BY p.updated_at DESC`,
  ).bind(ownerId, now).all<StoredPaste>();
}

export function findActiveOwnedPaste(db: D1Database, pasteId: string, ownerId: string, now = Date.now()) {
  return db.prepare(
    `SELECT p.id, p.ciphertext, p.content_iv AS contentIv, p.wrapped_key AS wrappedKey,
      p.wrapped_key_iv AS wrappedKeyIv, p.created_at AS createdAt, p.updated_at AS updatedAt,
      p.expires_at AS expiresAt, p.version
     FROM pastes p JOIN users u ON u.id = p.owner_id
     WHERE p.id = ? AND p.owner_id = ? AND u.deletion_requested_at IS NULL
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
  ).bind(pasteId, ownerId, now).first<StoredPaste>();
}

export function updateActiveOwnedPaste(
  db: D1Database,
  pasteId: string,
  ownerId: string,
  write: Omit<PasteWrite, "id">,
  updatedAt: number,
  expiresAt: number | null,
) {
  return db.prepare(
    `UPDATE pastes AS p SET ciphertext = ?, content_iv = ?, wrapped_key = ?, wrapped_key_iv = ?,
      updated_at = ?, expires_at = ?, version = version + 1
     WHERE p.id = ? AND p.owner_id = ?
       AND (p.expires_at IS NULL OR p.expires_at > ?)
       AND EXISTS (
         SELECT 1 FROM users u WHERE u.id = p.owner_id AND u.deletion_requested_at IS NULL
       )`,
  )
    .bind(
      write.ciphertext,
      write.contentIv,
      write.wrappedKey,
      write.wrappedKeyIv,
      updatedAt,
      expiresAt,
      pasteId,
      ownerId,
      updatedAt,
    )
    .run();
}

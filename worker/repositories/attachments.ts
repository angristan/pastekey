import type { StoredAttachment } from "../../src/lib/types";
import { validOpaque } from "../lib/http";
import type { AppContext } from "../types";

export type AttachmentInsert = {
  id: string;
  pasteId: string;
  ownerId: string;
  objectKey: string;
  ciphertextSize: number;
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  metadataCiphertext: string;
  metadataIv: string;
  createdAt: number;
};

export async function insertAttachment(db: D1Database, attachment: AttachmentInsert) {
  return db.prepare(
    `INSERT INTO attachments (
      id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
      metadata_ciphertext, metadata_iv, created_at
    )
    SELECT ?, p.id, ?, ?, ?, ?, ?, ?, ?, ?
    FROM pastes p JOIN users u ON u.id = p.owner_id
    WHERE p.id = ? AND p.owner_id = ? AND u.deletion_requested_at IS NULL`,
  )
    .bind(
      attachment.id,
      attachment.objectKey,
      attachment.ciphertextSize,
      attachment.contentIv,
      attachment.wrappedKey,
      attachment.wrappedKeyIv,
      attachment.metadataCiphertext,
      attachment.metadataIv,
      attachment.createdAt,
      attachment.pasteId,
      attachment.ownerId,
    )
    .run();
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

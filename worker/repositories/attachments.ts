import type { StoredAttachment } from "../../src/lib/types";
import { validOpaque } from "../lib/http";
import type { AppContext } from "../types";

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

import { validOpaque } from "./http";

export type AttachmentHeaders = {
  contentIv: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  metadataCiphertext: string;
  metadataIv: string;
};

export function readAttachmentHeaders(headers: Headers): AttachmentHeaders | null {
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
  return fields as AttachmentHeaders;
}

export async function streamR2Object(bucket: R2Bucket, objectKey: string) {
  const object = await bucket.get(objectKey);
  if (!object) return new Response(JSON.stringify({ error: "Encrypted attachment data not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Length": String(object.size),
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

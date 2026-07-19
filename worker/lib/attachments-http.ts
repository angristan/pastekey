import { Effect } from "effect";

import { R2FileStorage } from "../platform/cloudflare";
import { validOpaque } from "./http";

export type AttachmentHeaders = {
  readonly contentIv: string;
  readonly wrappedKey: string;
  readonly wrappedKeyIv: string;
  readonly metadataCiphertext: string;
  readonly metadataIv: string;
};

export function readAttachmentHeaders(headers: Headers): AttachmentHeaders | null {
  const contentIv = headers.get("X-Pastekey-Content-IV");
  const wrappedKey = headers.get("X-Pastekey-Wrapped-Key");
  const wrappedKeyIv = headers.get("X-Pastekey-Wrapped-Key-IV");
  const metadataCiphertext = headers.get("X-Pastekey-Metadata");
  const metadataIv = headers.get("X-Pastekey-Metadata-IV");
  if (
    contentIv === null ||
    wrappedKey === null ||
    wrappedKeyIv === null ||
    metadataCiphertext === null ||
    metadataIv === null ||
    !validOpaque(contentIv) ||
    !validOpaque(wrappedKey) ||
    !validOpaque(wrappedKeyIv) ||
    !validOpaque(metadataCiphertext, 20_000) ||
    !validOpaque(metadataIv)
  ) {
    return null;
  }
  return { contentIv, wrappedKey, wrappedKeyIv, metadataCiphertext, metadataIv };
}

const attachmentDataNotFound = () =>
  new Response(JSON.stringify({ error: "Encrypted attachment data not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });

const attachmentDataResponse = (object: R2ObjectBody) =>
  new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Length": String(object.size),
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });

export const streamAttachmentObject = Effect.fn("AttachmentsHttp.streamAttachmentObject")(
  function* (objectKey: string) {
    const storage = yield* R2FileStorage;
    const object = yield* storage.get(objectKey);
    return object === null ? attachmentDataNotFound() : attachmentDataResponse(object);
  },
);

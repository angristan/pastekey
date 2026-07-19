import { Schema } from "effect";

import { Base64Url, NonNegativeInteger, OpaqueId, Timestamp } from "./primitives";

export class AttachmentMetadata extends Schema.Class<AttachmentMetadata>("AttachmentMetadata")({
  name: Schema.String,
  type: Schema.String,
  size: NonNegativeInteger,
}) {}

export class StoredAttachment extends Schema.Class<StoredAttachment>("StoredAttachment")({
  id: OpaqueId,
  pasteId: OpaqueId,
  ciphertextSize: NonNegativeInteger,
  contentIv: Base64Url,
  wrappedKey: Base64Url,
  wrappedKeyIv: Base64Url,
  metadataCiphertext: Base64Url,
  metadataIv: Base64Url,
  createdAt: Timestamp,
}) {}

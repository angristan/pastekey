import { Schema } from "effect";

import { StoredAttachment } from "./attachments";
import { Base64Url, NonNegativeInteger, OpaqueId, Timestamp } from "./primitives";

const NullableTimestamp = Schema.Union([Timestamp, Schema.Null]);
const OpaqueCiphertext = Base64Url.check(Schema.isMaxLength(1_000_000));
const OpaqueEncryptedField = Base64Url.check(Schema.isMaxLength(10_000));

export const ItemKind = Schema.Literals(["paste", "files"]);
export type ItemKind = typeof ItemKind.Type;

export class PastePayload extends Schema.Class<PastePayload>("PastePayload")({
  title: Schema.String,
  content: Schema.String,
  language: Schema.String,
  kind: Schema.optionalKey(ItemKind),
}) {}

export class PasteWrite extends Schema.Class<PasteWrite>("PasteWrite")({
  id: OpaqueId,
  ciphertext: OpaqueCiphertext,
  contentIv: OpaqueEncryptedField,
  wrappedKey: OpaqueEncryptedField,
  wrappedKeyIv: OpaqueEncryptedField,
  expiresAt: Schema.optionalKey(NullableTimestamp),
}) {}

export class PasteUpdate extends Schema.Class<PasteUpdate>("PasteUpdate")({
  ciphertext: OpaqueCiphertext,
  contentIv: OpaqueEncryptedField,
  wrappedKey: OpaqueEncryptedField,
  wrappedKeyIv: OpaqueEncryptedField,
  expiresAt: Schema.optionalKey(NullableTimestamp),
}) {}

export class StoredPaste extends Schema.Class<StoredPaste>("StoredPaste")({
  id: OpaqueId,
  ciphertext: Base64Url,
  contentIv: Base64Url,
  wrappedKey: Base64Url,
  wrappedKeyIv: Base64Url,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: NullableTimestamp,
  version: NonNegativeInteger,
}) {}

export class ShareWrite extends Schema.Class<ShareWrite>("ShareWrite")({
  id: OpaqueId,
  wrappedKey: OpaqueEncryptedField,
  wrappedKeyIv: OpaqueEncryptedField,
  expiresAt: Schema.optionalKey(NullableTimestamp),
}) {}

export class StoredShare extends Schema.Class<StoredShare>("StoredShare")({
  id: OpaqueId,
  pasteId: OpaqueId,
  ciphertext: Base64Url,
  contentIv: Base64Url,
  wrappedKey: Base64Url,
  wrappedKeyIv: Base64Url,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: NullableTimestamp,
  attachments: Schema.Array(StoredAttachment).pipe(Schema.mutable),
}) {}

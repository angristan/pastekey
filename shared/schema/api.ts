import { Schema } from "effect";

import { StoredAttachment } from "./attachments";
import { StoredPaste } from "./pastes";
import { OpaqueId, Timestamp } from "./primitives";

const MutableStoredAttachments = Schema.Array(StoredAttachment).pipe(Schema.mutable);
const MutableStoredPastes = Schema.Array(StoredPaste).pipe(Schema.mutable);
const NullableTimestamp = Schema.Union([Timestamp, Schema.Null]);

export class AttachmentListResponse extends Schema.Class<AttachmentListResponse>("AttachmentListResponse")({
  attachments: MutableStoredAttachments,
}) {}

export class PasteListResponse extends Schema.Class<PasteListResponse>("PasteListResponse")({
  pastes: MutableStoredPastes,
}) {}

export class PasteCreateResponse extends Schema.Class<PasteCreateResponse>("PasteCreateResponse")({
  id: OpaqueId,
  createdAt: Timestamp,
}) {}

export class ShareSummary extends Schema.Class<ShareSummary>("ShareSummary")({
  id: OpaqueId,
  createdAt: Timestamp,
  expiresAt: NullableTimestamp,
}) {}

export class ShareListResponse extends Schema.Class<ShareListResponse>("ShareListResponse")({
  shares: Schema.Array(ShareSummary).pipe(Schema.mutable),
}) {}

export class ShareCreateResponse extends Schema.Class<ShareCreateResponse>("ShareCreateResponse")({
  id: OpaqueId,
  createdAt: Timestamp,
}) {}

export class AccountDeletionResponse extends Schema.Class<AccountDeletionResponse>("AccountDeletionResponse")({
  status: Schema.Literal("deleting"),
}) {}

export const NoContentResponse = Schema.Undefined;

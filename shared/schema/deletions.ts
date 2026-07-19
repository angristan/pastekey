import { Schema } from "effect";

import { NonNegativeInteger, OpaqueId } from "./primitives";

export class DeletionMessage extends Schema.Class<DeletionMessage>("DeletionMessage")({
  jobId: OpaqueId,
  cycle: Schema.optionalKey(NonNegativeInteger),
}) {}

export class AccountDeletionPayload extends Schema.Class<AccountDeletionPayload>("AccountDeletionPayload")({
  userId: OpaqueId,
}) {}

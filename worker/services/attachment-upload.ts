import { Effect, Result } from "effect";

import type { AttachmentHeaders } from "../lib/attachments-http";
import { ApiHttpError, isD1UniqueConstraint, serviceUnavailable } from "../lib/errors";
import {
  R2FileStorage,
  type R2FileValue,
} from "../platform/cloudflare";
import type { D1Error } from "../platform/d1";
import {
  countPasteAttachmentsAndReservations,
  finalizeAttachment,
  findActivePasteIdentity,
  findAttachmentIdentity,
  findFinalizedAttachment,
  findOwnedAttachmentDeletion,
  findOwnedAttachmentObject,
  listAttachments,
  reserveAttachment,
  stageAttachmentDeletion,
  stageReservationDeletion,
} from "../repositories/attachments";
import { findActiveOwnedPaste } from "../repositories/pastes";

export { dispatchPendingAttachmentDeletions } from "./deletions";

export type AttachmentUploadOutcome =
  | { readonly status: "created"; readonly createdAt: number }
  | { readonly status: "item-not-found" }
  | { readonly status: "identity-conflict" }
  | { readonly status: "file-limit" }
  | { readonly status: "storage-limit" }
  | { readonly status: "item-unavailable" };

export type AttachmentLookupOutcome<A> =
  | { readonly status: "found"; readonly value: A }
  | { readonly status: "item-not-found" }
  | { readonly status: "attachment-not-found" };

export type AttachmentDeleteOutcome =
  | { readonly status: "deleted" }
  | { readonly status: "item-not-found" }
  | { readonly status: "attachment-not-found" };

const mapUniqueConflict = (message: string) => (error: D1Error) =>
  isD1UniqueConstraint(error.cause)
    ? new ApiHttpError(409, message, { cause: error.cause })
    : error;

const ignoreFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

const cleanupRejectedUpload = Effect.fn("AttachmentUpload.cleanupRejectedUpload")(
  function* (reservationId: string, objectKey: string, deferDeletionDispatch: () => void) {
    const storage = yield* R2FileStorage;
    yield* Effect.all(
      [
        ignoreFailure(storage.delete(objectKey)),
        ignoreFailure(stageReservationDeletion(reservationId)),
      ],
      { concurrency: "unbounded", discard: true },
    );
    yield* Effect.sync(deferDeletionDispatch);
  },
);

const diagnoseReservationFailure = Effect.fn("AttachmentUpload.diagnoseReservationFailure")(
  function* (input: {
    readonly pasteId: string;
    readonly fileId: string;
    readonly ownerId: string;
    readonly objectKey: string;
    readonly limits: { readonly maxFilesPerPaste: number };
  }) {
    const [paste, identity, fileCount] = yield* Effect.all(
      [
        findActivePasteIdentity(input.pasteId, input.ownerId),
        findAttachmentIdentity(input.fileId, input.objectKey),
        countPasteAttachmentsAndReservations(input.pasteId),
      ],
      { concurrency: "unbounded" },
    );
    if (paste === null) return { status: "item-not-found" } satisfies AttachmentUploadOutcome;
    if (identity !== null) return { status: "identity-conflict" } satisfies AttachmentUploadOutcome;
    if ((fileCount?.count ?? 0) >= input.limits.maxFilesPerPaste) {
      return { status: "file-limit" } satisfies AttachmentUploadOutcome;
    }
    return { status: "storage-limit" } satisfies AttachmentUploadOutcome;
  },
);

export const uploadAttachment = Effect.fn("AttachmentUpload.uploadAttachment")(
  function* (
    input: {
      readonly pasteId: string;
      readonly fileId: string;
      readonly ownerId: string;
      readonly objectKey: string;
      readonly ciphertextSize: number;
      readonly body: R2FileValue;
      readonly headers: AttachmentHeaders;
      readonly limits: {
        readonly maxFilesPerPaste: number;
        readonly maxStorageBytes: number;
      };
    },
    deferDeletionDispatch: () => void,
  ) {
    const reservation = {
      id: input.fileId,
      pasteId: input.pasteId,
      ownerId: input.ownerId,
      objectKey: input.objectKey,
      ciphertextSize: input.ciphertextSize,
    };
    const reserved = yield* reserveAttachment(reservation, input.limits).pipe(
      Effect.mapError(mapUniqueConflict("Attachment ID is already reserved")),
    );
    if (!reserved.meta.changes) return yield* diagnoseReservationFailure(input);

    const storage = yield* R2FileStorage;
    const uploaded = yield* Effect.result(
      storage.put(input.objectKey, input.body, {
        httpMetadata: { contentType: "application/octet-stream" },
      }),
    );
    if (Result.isFailure(uploaded)) {
      yield* cleanupRejectedUpload(input.fileId, input.objectKey, deferDeletionDispatch);
      return yield* Effect.fail(
        serviceUnavailable("Encrypted attachment upload failed", uploaded.failure.cause),
      );
    }

    const now = Date.now();
    const attachment = {
      ...reservation,
      contentIv: input.headers.contentIv,
      wrappedKey: input.headers.wrappedKey,
      wrappedKeyIv: input.headers.wrappedKeyIv,
      metadataCiphertext: input.headers.metadataCiphertext,
      metadataIv: input.headers.metadataIv,
      createdAt: now,
    };
    const finalized = yield* Effect.result(finalizeAttachment(attachment));
    if (Result.isFailure(finalized)) {
      // A lost D1 response can hide a committed row. An exact recheck recovers
      // that commit; otherwise the durable reservation lifecycle owns cleanup.
      const recovered = yield* findFinalizedAttachment(attachment).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (recovered !== null) {
        return { status: "created", createdAt: recovered.createdAt } satisfies AttachmentUploadOutcome;
      }
      return yield* Effect.fail(
        mapUniqueConflict("Attachment could not be saved")(finalized.failure),
      );
    }
    if (!finalized.success.meta.changes) {
      yield* cleanupRejectedUpload(input.fileId, input.objectKey, deferDeletionDispatch);
      return { status: "item-unavailable" } satisfies AttachmentUploadOutcome;
    }
    return { status: "created", createdAt: now } satisfies AttachmentUploadOutcome;
  },
);

export const listAttachmentsForPaste = Effect.fn("AttachmentUpload.listAttachmentsForPaste")(
  function* (pasteId: string, ownerId: string) {
    const paste = yield* findActiveOwnedPaste(pasteId, ownerId);
    if (paste === null) return null;
    return yield* listAttachments(pasteId);
  },
);

export const openOwnedAttachment = Effect.fn("AttachmentUpload.openOwnedAttachment")(
  function* (pasteId: string, fileId: string, ownerId: string) {
    const paste = yield* findActiveOwnedPaste(pasteId, ownerId);
    if (paste === null) {
      return { status: "item-not-found" } satisfies AttachmentLookupOutcome<never>;
    }
    const attachment = yield* findOwnedAttachmentObject(fileId, pasteId, ownerId);
    if (attachment === null) {
      return { status: "attachment-not-found" } satisfies AttachmentLookupOutcome<never>;
    }
    return { status: "found", value: attachment } satisfies AttachmentLookupOutcome<typeof attachment>;
  },
);

export const deleteOwnedAttachment = Effect.fn("AttachmentUpload.deleteOwnedAttachment")(
  function* (pasteId: string, fileId: string, ownerId: string) {
    const paste = yield* findActiveOwnedPaste(pasteId, ownerId);
    if (paste === null) return { status: "item-not-found" } satisfies AttachmentDeleteOutcome;

    const attachment = yield* findOwnedAttachmentDeletion(fileId, pasteId, ownerId);
    if (attachment === null) {
      return { status: "attachment-not-found" } satisfies AttachmentDeleteOutcome;
    }
    yield* stageAttachmentDeletion(attachment, pasteId, ownerId);
    return { status: "deleted" } satisfies AttachmentDeleteOutcome;
  },
);

import { Effect, Schema } from "effect";

import type { PasteWrite, ShareWrite } from "../../shared/protocol/pastes";
import { ApiHttpError, isD1UniqueConstraint } from "../lib/errors";
import { D1, type D1Error } from "../platform/d1";
import {
  deletePasteShare,
  findActiveOwnedPaste,
  findActiveShare,
  findActiveShareAttachment,
  insertShare,
  listPasteAttachments,
  listPasteShares,
  updateActiveOwnedPaste,
} from "../repositories/pastes";

export type CreatePasteOutcome =
  | { status: "created"; createdAt: number }
  | { status: "account-unavailable" }
  | { status: "quota-reached" };

const mapUniqueConflict = (message: string) => (error: D1Error) =>
  isD1UniqueConstraint(error.cause)
    ? new ApiHttpError(409, message, { cause: error.cause })
    : error;

export const createPaste = Effect.fn("PasteMutations.createPaste")(
  function* (
    ownerId: string,
    write: PasteWrite,
    maxPastesPerUser: number,
    now = Date.now(),
  ) {
    const d1 = yield* D1;
    const inserted = yield* d1.run(
      d1.bind(
        d1.prepare(
          `INSERT INTO pastes (
        id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv,
        created_at, updated_at, expires_at
      )
      SELECT ?, u.id, ?, ?, ?, ?, ?, ?, ?
      FROM users u
      WHERE u.id = ? AND u.deletion_requested_at IS NULL
        AND (SELECT COUNT(*) FROM pastes WHERE owner_id = u.id) < ?`,
        ),
        write.id,
        write.ciphertext,
        write.contentIv,
        write.wrappedKey,
        write.wrappedKeyIv,
        now,
        now,
        write.expiresAt ?? null,
        ownerId,
        maxPastesPerUser,
      ),
    ).pipe(Effect.mapError(mapUniqueConflict("Item ID already exists")));

    if (inserted.meta.changes) {
      return { status: "created", createdAt: now } satisfies CreatePasteOutcome;
    }

    const active = yield* d1.first(
      d1.bind(
        d1.prepare("SELECT id FROM users WHERE id = ? AND deletion_requested_at IS NULL"),
        ownerId,
      ),
      Schema.Struct({ id: Schema.String }),
    );
    return active
      ? { status: "quota-reached" } satisfies CreatePasteOutcome
      : { status: "account-unavailable" } satisfies CreatePasteOutcome;
  },
);

export const updatePaste = Effect.fn("PasteMutations.updatePaste")(
  function* (
    pasteId: string,
    ownerId: string,
    write: Omit<PasteWrite, "id">,
    now = Date.now(),
  ) {
    const result = yield* updateActiveOwnedPaste(
      pasteId,
      ownerId,
      write,
      now,
      write.expiresAt ?? null,
    );
    return Boolean(result.meta.changes);
  },
);

export const deletePaste = Effect.fn("PasteMutations.deletePaste")(
  function* (pasteId: string, ownerId: string, now = Date.now()) {
    const d1 = yield* D1;
    const results = yield* d1.batch([
      d1.bind(
        d1.prepare(
          `INSERT OR IGNORE INTO deletion_jobs (
        id, owner_id, object_key, ciphertext_size, created_at, queued_at
      )
      SELECT a.id, p.owner_id, a.object_key, a.ciphertext_size, ?, NULL
      FROM attachments a JOIN pastes p ON p.id = a.paste_id
      WHERE p.id = ? AND p.owner_id = ?`,
        ),
        now,
        pasteId,
        ownerId,
      ),
      d1.bind(
        d1.prepare("DELETE FROM pastes WHERE id = ? AND owner_id = ?"),
        pasteId,
        ownerId,
      ),
    ]);
    return Boolean(results[1]?.meta.changes);
  },
);

export const listShares = Effect.fn("PasteMutations.listShares")(
  function* (pasteId: string, ownerId: string) {
    const owned = yield* findActiveOwnedPaste(pasteId, ownerId);
    if (owned === null) return null;
    return yield* listPasteShares(pasteId);
  },
);

export const createShare = Effect.fn("PasteMutations.createShare")(
  function* (
    pasteId: string,
    ownerId: string,
    write: ShareWrite,
    expiresAt: number | null,
  ) {
    const paste = yield* findActiveOwnedPaste(pasteId, ownerId);
    if (paste === null) return null;

    const createdAt = Date.now();
    yield* insertShare(
      pasteId,
      write.id,
      write.wrappedKey,
      write.wrappedKeyIv,
      createdAt,
      expiresAt,
    ).pipe(Effect.mapError(mapUniqueConflict("Share ID already exists")));
    return createdAt;
  },
);

export const revokeShare = Effect.fn("PasteMutations.revokeShare")(
  function* (pasteId: string, shareId: string, ownerId: string) {
    const owned = yield* findActiveOwnedPaste(pasteId, ownerId);
    if (owned === null) return null;
    const result = yield* deletePasteShare(shareId, pasteId);
    return Boolean(result.meta.changes);
  },
);

export const openShare = Effect.fn("PasteMutations.openShare")(
  function* (shareId: string) {
    const share = yield* findActiveShare(shareId);
    if (share === null) return null;
    const attachments = yield* listPasteAttachments(share.pasteId);
    return { ...share, attachments };
  },
);

export const openShareAttachment = Effect.fn("PasteMutations.openShareAttachment")(
  function* (shareId: string, fileId: string) {
    return yield* findActiveShareAttachment(fileId, shareId);
  },
);

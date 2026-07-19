import { Effect, Schema } from "effect";

import { D1, type D1Statement } from "../platform/d1";
import {
  drainPendingDeletions,
  recoverStaleDeletions,
} from "./deletions";

// Keep each set-based statement below D1's bound-variable ceiling.
const EXPIRY_BATCH_SIZE = 90;
const MAX_CLEANUP_BATCHES = 5;

const IdRow = Schema.Struct({ id: Schema.String });

type CleanupCandidates = {
  readonly attachmentIds: ReadonlyArray<string>;
  readonly reservationIds: ReadonlyArray<string>;
};

export const cleanupExpired = Effect.fn("Cleanup.cleanupExpired")(
  function* (now = Date.now()) {
    for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch += 1) {
      const candidates = yield* findCleanupCandidates(now);
      if (
        candidates.attachmentIds.length === 0 &&
        candidates.reservationIds.length === 0
      ) {
        break;
      }
      yield* stageCleanupCandidates(candidates, now);
    }
    yield* deleteExpiredGlobalRows(now);
    yield* recoverStaleDeletions(now);
    yield* drainPendingDeletions(now);
  },
);

export const findCleanupCandidates = Effect.fn("Cleanup.findCleanupCandidates")(
  function* (now: number) {
    const d1 = yield* D1;
    const [expired, abandonedUploads] = yield* Effect.all(
      [
        d1.all(
          d1.bind(
            d1.prepare(
              `SELECT a.id FROM attachments a JOIN pastes p ON p.id = a.paste_id
       WHERE p.expires_at IS NOT NULL AND p.expires_at <= ?
       ORDER BY p.expires_at, a.created_at LIMIT ?`,
            ),
            now,
            EXPIRY_BATCH_SIZE,
          ),
          IdRow,
        ),
        d1.all(
          d1.bind(
            d1.prepare(
              `SELECT id FROM upload_reservations WHERE expires_at <= ?
       ORDER BY expires_at LIMIT ?`,
            ),
            now,
            EXPIRY_BATCH_SIZE,
          ),
          IdRow,
        ),
      ],
      { concurrency: "unbounded" },
    );
    return {
      attachmentIds: expired.results.map(({ id }) => id),
      reservationIds: abandonedUploads.results.map(({ id }) => id),
    } satisfies CleanupCandidates;
  },
);

export const stageCleanupCandidates = Effect.fn("Cleanup.stageCleanupCandidates")(
  function* (candidates: CleanupCandidates, now: number) {
    const d1 = yield* D1;
    const statements: Array<D1Statement> = [];
    if (candidates.attachmentIds.length > 0) {
      const ids = candidates.attachmentIds;
      const slots = placeholders(ids);
      statements.push(
        d1.bind(
          d1.prepare(
            `INSERT OR IGNORE INTO deletion_jobs (
          id, owner_id, object_key, ciphertext_size, created_at, queued_at
        )
        SELECT a.id, p.owner_id, a.object_key, a.ciphertext_size, ?, NULL
        FROM attachments a JOIN pastes p ON p.id = a.paste_id
        WHERE a.id IN (${slots})
          AND p.expires_at IS NOT NULL AND p.expires_at <= ?`,
          ),
          now,
          ...ids,
          now,
        ),
        d1.bind(
          d1.prepare(
            `DELETE FROM attachments AS a
         WHERE a.id IN (${slots})
           AND EXISTS (
             SELECT 1 FROM pastes p WHERE p.id = a.paste_id
               AND p.expires_at IS NOT NULL AND p.expires_at <= ?
           )
           AND EXISTS (
             SELECT 1 FROM deletion_jobs d
             WHERE d.id = a.id AND d.object_key = a.object_key
           )`,
          ),
          ...ids,
          now,
        ),
      );
    }
    if (candidates.reservationIds.length > 0) {
      const ids = candidates.reservationIds;
      const slots = placeholders(ids);
      statements.push(
        d1.bind(
          d1.prepare(
            `INSERT OR IGNORE INTO deletion_jobs (
          id, owner_id, object_key, ciphertext_size, created_at, queued_at
        )
        SELECT r.id, r.owner_id, r.object_key, r.ciphertext_size, ?, NULL
        FROM upload_reservations r
        WHERE r.id IN (${slots}) AND r.expires_at <= ?`,
          ),
          now,
          ...ids,
          now,
        ),
        d1.bind(
          d1.prepare(
            `DELETE FROM upload_reservations AS r
         WHERE r.id IN (${slots}) AND r.expires_at <= ?
           AND EXISTS (
             SELECT 1 FROM deletion_jobs d
             WHERE d.id = r.id AND d.object_key = r.object_key
           )`,
          ),
          ...ids,
          now,
        ),
      );
    }
    yield* d1.batch(statements);
  },
);

const deleteExpiredGlobalRows = Effect.fn("Cleanup.deleteExpiredGlobalRows")(
  function* (now: number) {
    const d1 = yield* D1;
    yield* d1.batch([
      d1.bind(
        d1.prepare(
          `DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= ?
       AND NOT EXISTS (SELECT 1 FROM attachments WHERE attachments.paste_id = pastes.id)`,
        ),
        now,
      ),
      d1.bind(
        d1.prepare(
          "DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?",
        ),
        now,
      ),
      d1.bind(
        d1.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?"),
        now,
      ),
      d1.bind(
        d1.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
        now,
      ),
    ]);
  },
);

function placeholders(values: ReadonlyArray<unknown>) {
  return values.map(() => "?").join(",");
}

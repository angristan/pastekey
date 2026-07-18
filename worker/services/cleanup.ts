import type { Bindings } from "../types";
import { drainPendingDeletions, recoverStaleDeletions } from "./deletions";

// Keep each set-based statement below D1's bound-variable ceiling.
const EXPIRY_BATCH_SIZE = 90;
const MAX_CLEANUP_BATCHES = 5;

type CleanupCandidates = {
  attachmentIds: string[];
  reservationIds: string[];
};

export async function cleanupExpired(env: Bindings) {
  const now = Date.now();
  for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch += 1) {
    const candidates = await findCleanupCandidates(env.DB, now);
    if (!candidates.attachmentIds.length && !candidates.reservationIds.length) break;
    await stageCleanupCandidates(env.DB, candidates, now);
  }
  await recoverStaleDeletions(env.DB, now);
  await drainPendingDeletions(env, now);
}

export async function findCleanupCandidates(db: D1Database, now: number): Promise<CleanupCandidates> {
  const [expired, abandonedUploads] = await Promise.all([
    db.prepare(
      `SELECT a.id FROM attachments a JOIN pastes p ON p.id = a.paste_id
       WHERE p.expires_at IS NOT NULL AND p.expires_at <= ?
       ORDER BY p.expires_at, a.created_at LIMIT ?`,
    )
      .bind(now, EXPIRY_BATCH_SIZE)
      .all<{ id: string }>(),
    db.prepare(
      `SELECT id FROM upload_reservations WHERE expires_at <= ?
       ORDER BY expires_at LIMIT ?`,
    )
      .bind(now, EXPIRY_BATCH_SIZE)
      .all<{ id: string }>(),
  ]);
  return {
    attachmentIds: expired.results.map(({ id }) => id),
    reservationIds: abandonedUploads.results.map(({ id }) => id),
  };
}

export async function stageCleanupCandidates(db: D1Database, candidates: CleanupCandidates, now: number) {
  const statements: D1PreparedStatement[] = [];
  if (candidates.attachmentIds.length) {
    const ids = candidates.attachmentIds;
    const slots = placeholders(ids);
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO deletion_jobs (
          id, owner_id, object_key, ciphertext_size, created_at, queued_at
        )
        SELECT a.id, p.owner_id, a.object_key, a.ciphertext_size, ?, NULL
        FROM attachments a JOIN pastes p ON p.id = a.paste_id
        WHERE a.id IN (${slots})
          AND p.expires_at IS NOT NULL AND p.expires_at <= ?`,
      ).bind(now, ...ids, now),
      db.prepare(
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
      ).bind(...ids, now),
    );
  }
  if (candidates.reservationIds.length) {
    const ids = candidates.reservationIds;
    const slots = placeholders(ids);
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO deletion_jobs (
          id, owner_id, object_key, ciphertext_size, created_at, queued_at
        )
        SELECT r.id, r.owner_id, r.object_key, r.ciphertext_size, ?, NULL
        FROM upload_reservations r
        WHERE r.id IN (${slots}) AND r.expires_at <= ?`,
      ).bind(now, ...ids, now),
      db.prepare(
        `DELETE FROM upload_reservations AS r
         WHERE r.id IN (${slots}) AND r.expires_at <= ?
           AND EXISTS (
             SELECT 1 FROM deletion_jobs d
             WHERE d.id = r.id AND d.object_key = r.object_key
           )`,
      ).bind(...ids, now),
    );
  }
  statements.push(
    db.prepare(
      `DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= ?
       AND NOT EXISTS (SELECT 1 FROM attachments WHERE attachments.paste_id = pastes.id)`,
    ).bind(now),
    db.prepare("DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
    db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
  );
  await db.batch(statements);
}

function placeholders(values: unknown[]) {
  return values.map(() => "?").join(",");
}

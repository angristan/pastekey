import { OPAQUE_ID } from "../lib/config";
import type { Bindings, DeletionJobRow, DeletionMessage } from "../types";

export const DELETION_QUEUE_NAME = "pastekey-deletions";
export const DELETION_DLQ_NAME = "pastekey-deletions-dlq";

const ENQUEUE_BATCH_SIZE = 100;
// A cleanup run can stage up to 900 attachment and reservation jobs.
const MAX_ENQUEUE_BATCHES = 10;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 24 * HOUR_MS;
const STALE_DISPATCH_MS = 25 * HOUR_MS;

export type AttachmentDeletion = {
  id: string;
  ownerId: string;
  objectKey: string;
  ciphertextSize: number;
};

export function stageDeletion(db: D1Database, deletion: AttachmentDeletion, createdAt = Date.now()) {
  return db.prepare(
    `INSERT OR IGNORE INTO deletion_jobs (
      id, owner_id, object_key, ciphertext_size, created_at, queued_at
    ) VALUES (?, ?, ?, ?, ?, NULL)`,
  ).bind(deletion.id, deletion.ownerId, deletion.objectKey, deletion.ciphertextSize, createdAt);
}

export async function enqueuePendingDeletions(env: Bindings, now = Date.now()) {
  const pending = await env.DB.prepare(
    `SELECT id, failure_cycles AS cycle FROM deletion_jobs
     WHERE queued_at IS NULL AND next_attempt_at <= ?
     ORDER BY next_attempt_at, created_at LIMIT ?`,
  )
    .bind(now, ENQUEUE_BATCH_SIZE)
    .all<{ id: string; cycle: number }>();
  if (!pending.results.length) return 0;

  await env.DELETION_QUEUE.sendBatch(
    pending.results.map(({ id, cycle }) => ({ body: { jobId: id, cycle }, contentType: "json" as const })),
  );

  const queuedAt = Date.now();
  await env.DB.batch(
    pending.results.map(({ id, cycle }) =>
      env.DB.prepare(
        `UPDATE deletion_jobs SET queued_at = ?
         WHERE id = ? AND failure_cycles = ? AND queued_at IS NULL`,
      ).bind(queuedAt, id, cycle),
    ),
  );
  return pending.results.length;
}

export async function drainPendingDeletions(env: Bindings, now = Date.now()) {
  let total = 0;
  for (let batch = 0; batch < MAX_ENQUEUE_BATCHES; batch += 1) {
    const queued = await enqueuePendingDeletions(env, now);
    total += queued;
    if (queued < ENQUEUE_BATCH_SIZE) break;
  }
  return total;
}

export async function recoverStaleDeletions(db: D1Database, now = Date.now()) {
  const result = await db.prepare(
    `UPDATE deletion_jobs SET
      failure_cycles = failure_cycles + 1,
      queued_at = NULL,
      last_failed_at = ?,
      next_attempt_at = ?
     WHERE queued_at IS NOT NULL AND queued_at <= ?`,
  )
    .bind(now, now + MAX_BACKOFF_MS, now - STALE_DISPATCH_MS)
    .run();
  if (result.meta.changes) {
    console.error("Recovered stale ciphertext deletion dispatches", { count: result.meta.changes });
  }
  return result.meta.changes;
}

export async function consumeDeletionQueue(batch: MessageBatch<DeletionMessage>, env: Bindings) {
  if (batch.queue === (env.DELETION_DLQ_NAME ?? DELETION_DLQ_NAME)) return consumeDeadLetters(batch, env);
  if (batch.queue === (env.DELETION_QUEUE_NAME ?? DELETION_QUEUE_NAME)) return consumePrimaryDeletions(batch, env);

  console.error("Received ciphertext deletion messages from an unknown queue");
  batch.retryAll({ delaySeconds: 300 });
}

async function consumePrimaryDeletions(batch: MessageBatch<DeletionMessage>, env: Bindings) {
  for (const message of batch.messages) {
    if (!validMessage(message.body)) {
      console.error("Discarding invalid ciphertext deletion message");
      message.ack();
      continue;
    }

    const job = await findJob(env.DB, message.body.jobId);
    if (!job) {
      message.ack();
      continue;
    }

    try {
      await env.FILES.delete(job.object_key);
      await env.DB.prepare("DELETE FROM deletion_jobs WHERE id = ?").bind(job.id).run();
      message.ack();
    } catch {
      console.error("Queued ciphertext deletion failed", { attempt: message.attempts });
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function consumeDeadLetters(batch: MessageBatch<DeletionMessage>, env: Bindings) {
  for (const message of batch.messages) {
    if (!validMessage(message.body)) {
      console.error("Discarding invalid ciphertext deletion dead letter");
      message.ack();
      continue;
    }

    const job = await findJob(env.DB, message.body.jobId);
    if (!job || cycleOf(message.body) !== job.failure_cycles || job.queued_at === null) {
      message.ack();
      continue;
    }

    const cycle = job.failure_cycles + 1;
    const delayMs = retryDelayMs(cycle);
    const now = Date.now();
    try {
      await env.DB.prepare(
        `UPDATE deletion_jobs SET
          failure_cycles = failure_cycles + 1,
          queued_at = NULL,
          last_failed_at = ?,
          next_attempt_at = ?
         WHERE id = ? AND failure_cycles = ? AND queued_at IS NOT NULL`,
      )
        .bind(now, now + delayMs, job.id, job.failure_cycles)
        .run();
      console.error("Ciphertext deletion scheduled for another retry cycle", {
        cycle,
        delayHours: delayMs / HOUR_MS,
      });
      message.ack();
    } catch {
      console.error("Could not persist ciphertext deletion dead letter", { attempt: message.attempts });
      message.retry({ delaySeconds: 300 });
    }
  }
}

function findJob(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM deletion_jobs WHERE id = ?").bind(id).first<DeletionJobRow>();
}

function validMessage(value: DeletionMessage | null | undefined) {
  return Boolean(
    value &&
      OPAQUE_ID.test(value.jobId) &&
      (value.cycle === undefined || (Number.isSafeInteger(value.cycle) && value.cycle >= 0)),
  );
}

function cycleOf(message: DeletionMessage) {
  return message.cycle ?? 0;
}

export function retryDelayMs(cycle: number) {
  return Math.min(2 ** Math.max(0, cycle - 1) * HOUR_MS, MAX_BACKOFF_MS);
}

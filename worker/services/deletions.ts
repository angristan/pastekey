import { OPAQUE_ID } from "../lib/config";
import type { Bindings, DeletionJobRow, DeletionMessage } from "../types";

const ENQUEUE_BATCH_SIZE = 100;

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

export async function enqueuePendingDeletions(env: Bindings) {
  const pending = await env.DB.prepare(
    `SELECT id FROM deletion_jobs WHERE queued_at IS NULL ORDER BY created_at LIMIT ?`,
  )
    .bind(ENQUEUE_BATCH_SIZE)
    .all<{ id: string }>();
  if (!pending.results.length) return 0;

  await env.DELETION_QUEUE.sendBatch(
    pending.results.map(({ id }) => ({ body: { jobId: id }, contentType: "json" as const })),
  );

  const queuedAt = Date.now();
  await env.DB.batch(
    pending.results.map(({ id }) =>
      env.DB.prepare("UPDATE deletion_jobs SET queued_at = ? WHERE id = ? AND queued_at IS NULL").bind(queuedAt, id),
    ),
  );
  return pending.results.length;
}

export async function consumeDeletionQueue(batch: MessageBatch<DeletionMessage>, env: Bindings) {
  for (const message of batch.messages) {
    if (!message.body || !OPAQUE_ID.test(message.body.jobId)) {
      console.error("Discarding invalid ciphertext deletion message");
      message.ack();
      continue;
    }

    const job = await env.DB.prepare("SELECT * FROM deletion_jobs WHERE id = ?")
      .bind(message.body.jobId)
      .first<DeletionJobRow>();
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

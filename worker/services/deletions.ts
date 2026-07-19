import { Cause, Effect, Option, Schema } from "effect";

import { DeletionMessage as DeletionMessageSchema } from "../../shared/schema/deletions";
import {
  DeletionQueue,
  R2FileStorage,
  type R2FileStorageError,
  type R2FileStorageOperation,
} from "../platform/cloudflare";
import { D1, type D1Error, type D1Operation } from "../platform/d1";
import {
  traceWorkerOperation,
  type WorkerQueueKind,
} from "../lib/tracing";
import { runWorkerEffect } from "../runtime";
import type { Bindings, DeletionMessage } from "../types";

export const DELETION_QUEUE_NAME = "pastekey-deletions";
export const DELETION_DLQ_NAME = "pastekey-deletions-dlq";

const ENQUEUE_BATCH_SIZE = 100;
// A cleanup run can stage up to 900 attachment and reservation jobs.
const MAX_ENQUEUE_BATCHES = 10;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 24 * HOUR_MS;
const STALE_DISPATCH_MS = 25 * HOUR_MS;

const PendingDeletionRow = Schema.Struct({
  id: Schema.String,
  cycle: Schema.Number,
});

const DeletionJobRow = Schema.Struct({
  id: Schema.String,
  owner_id: Schema.String,
  object_key: Schema.String,
  ciphertext_size: Schema.Number,
  created_at: Schema.Number,
  queued_at: Schema.Union([Schema.Number, Schema.Null]),
  failure_cycles: Schema.Number,
  next_attempt_at: Schema.Number,
  last_failed_at: Schema.Union([Schema.Number, Schema.Null]),
});

export type AttachmentDeletion = {
  readonly id: string;
  readonly ownerId: string;
  readonly objectKey: string;
  readonly ciphertextSize: number;
};

export const stageDeletion = Effect.fn("Deletions.stageDeletion")(
  function* (deletion: AttachmentDeletion, createdAt = Date.now()) {
    const d1 = yield* D1;
    return yield* d1.run(
      d1.bind(
        d1.prepare(
          `INSERT OR IGNORE INTO deletion_jobs (
      id, owner_id, object_key, ciphertext_size, created_at, queued_at
    ) VALUES (?, ?, ?, ?, ?, NULL)`,
        ),
        deletion.id,
        deletion.ownerId,
        deletion.objectKey,
        deletion.ciphertextSize,
        createdAt,
      ),
    );
  },
);

/** Dispatches one bounded batch and atomically marks every selected job queued. */
export const dispatchPendingAttachmentDeletions = Effect.fn(
  "Deletions.dispatchPendingAttachmentDeletions",
)(function* (now = Date.now()) {
  const d1 = yield* D1;
  const pending = yield* d1.all(
    d1.bind(
      d1.prepare(
        `SELECT id, failure_cycles AS cycle FROM deletion_jobs
     WHERE queued_at IS NULL AND next_attempt_at <= ?
     ORDER BY next_attempt_at, created_at LIMIT ?`,
      ),
      now,
      ENQUEUE_BATCH_SIZE,
    ),
    PendingDeletionRow,
  );
  if (pending.results.length === 0) return 0;

  const queue = yield* DeletionQueue;
  yield* queue.sendBatch(
    pending.results.map(({ id, cycle }) => ({
      body: { jobId: id, cycle },
      contentType: "json",
    })),
  );

  const queuedAt = Date.now();
  yield* d1.batch(
    pending.results.map(({ id, cycle }) =>
      d1.bind(
        d1.prepare(
          `UPDATE deletion_jobs SET queued_at = ?
         WHERE id = ? AND failure_cycles = ? AND queued_at IS NULL`,
        ),
        queuedAt,
        id,
        cycle,
      )
    ),
  );
  return pending.results.length;
});

// Compatibility adapter for the HTTP route while its host integration remains Promise-based.
export function enqueuePendingDeletions(env: Bindings, now = Date.now()) {
  return runWorkerEffect(env, dispatchPendingAttachmentDeletions(now));
}

export const drainPendingDeletions = Effect.fn("Deletions.drainPendingDeletions")(
  function* (now = Date.now()) {
    let total = 0;
    for (let batch = 0; batch < MAX_ENQUEUE_BATCHES; batch += 1) {
      const queued = yield* dispatchPendingAttachmentDeletions(now);
      total += queued;
      if (queued < ENQUEUE_BATCH_SIZE) break;
    }
    return total;
  },
);

export const recoverStaleDeletions = Effect.fn("Deletions.recoverStaleDeletions")(
  function* (now = Date.now()) {
    const d1 = yield* D1;
    const result = yield* d1.run(
      d1.bind(
        d1.prepare(
          `UPDATE deletion_jobs SET
      failure_cycles = failure_cycles + 1,
      queued_at = NULL,
      last_failed_at = ?,
      next_attempt_at = ?
     WHERE queued_at IS NOT NULL AND queued_at <= ?`,
        ),
        now,
        now + MAX_BACKOFF_MS,
        now - STALE_DISPATCH_MS,
      ),
    );
    if (result.meta.changes) {
      yield* Effect.sync(() => {
        console.error("Recovered stale ciphertext deletion dispatches", {
          count: result.meta.changes,
        });
      });
    }
    return result.meta.changes;
  },
);

const findJob = Effect.fn("Deletions.findJob")(function* (id: string) {
  const d1 = yield* D1;
  return yield* d1.first(
    d1.bind(d1.prepare("SELECT * FROM deletion_jobs WHERE id = ?"), id),
    DeletionJobRow,
  );
});

const deleteQueuedCiphertext = Effect.fn("Deletions.deleteQueuedCiphertext")(
  function* (jobId: string) {
    const job = yield* findJob(jobId);
    if (job === null) return;

    const files = yield* R2FileStorage;
    yield* files.delete(job.object_key);

    const d1 = yield* D1;
    yield* d1.run(
      d1.bind(d1.prepare("DELETE FROM deletion_jobs WHERE id = ?"), job.id),
    );
  },
);

const rescheduleDeadLetter = Effect.fn("Deletions.rescheduleDeadLetter")(
  function* (message: DeletionMessage, now = Date.now()) {
    const job = yield* findJob(message.jobId);
    if (
      job === null ||
      cycleOf(message) !== job.failure_cycles ||
      job.queued_at === null
    ) {
      return null;
    }

    const cycle = job.failure_cycles + 1;
    const delayMs = retryDelayMs(cycle);
    const d1 = yield* D1;
    yield* d1.run(
      d1.bind(
        d1.prepare(
          `UPDATE deletion_jobs SET
          failure_cycles = failure_cycles + 1,
          queued_at = NULL,
          last_failed_at = ?,
          next_attempt_at = ?
         WHERE id = ? AND failure_cycles = ? AND queued_at IS NOT NULL`,
        ),
        now,
        now + delayMs,
        job.id,
        job.failure_cycles,
      ),
    );
    return { cycle, delayHours: delayMs / HOUR_MS };
  },
);

type QueueFailureDiagnostic =
  | {
    readonly errorClass: "D1Error";
    readonly operation: D1Operation;
    readonly causeClass: string;
  }
  | {
    readonly errorClass: "R2FileStorageError";
    readonly operation: R2FileStorageOperation;
    readonly causeClass: string;
  }
  | {
    readonly errorClass: "Defect" | "Interrupt" | "UnknownCause";
    readonly operation: "delete-ciphertext" | "reschedule-dead-letter";
    readonly causeClass: string;
  };

type PrimaryDeletionDirective =
  | { readonly _tag: "Acknowledge" }
  | { readonly _tag: "DiscardInvalid" }
  | {
    readonly _tag: "Retry";
    readonly delaySeconds: 60;
    readonly diagnostic: QueueFailureDiagnostic;
  };

type DeadLetterDirective =
  | { readonly _tag: "Acknowledge"; readonly scheduled: { readonly cycle: number; readonly delayHours: number } | null }
  | { readonly _tag: "DiscardInvalid" }
  | {
    readonly _tag: "Retry";
    readonly delaySeconds: 300;
    readonly diagnostic: QueueFailureDiagnostic;
  };

type QueueProcessingError = D1Error | R2FileStorageError;

const processPrimaryDeletion: (
  value: unknown,
) => Effect.Effect<PrimaryDeletionDirective, never, D1 | R2FileStorage> =
  Effect.fn("Deletions.processPrimaryDeletion")(function* (value: unknown) {
    return yield* Schema.decodeUnknownEffect(DeletionMessageSchema)(value).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed({ _tag: "DiscardInvalid" } as const),
        onSuccess: (body) => deleteQueuedCiphertext(body.jobId).pipe(
          Effect.matchCause({
            onFailure: (cause) => ({
              _tag: "Retry" as const,
              delaySeconds: 60 as const,
              diagnostic: queueFailureDiagnostic(cause, "delete-ciphertext"),
            }),
            onSuccess: () => ({ _tag: "Acknowledge" as const }),
          }),
        ),
      }),
    );
  });

const processDeadLetter: (
  value: unknown,
) => Effect.Effect<DeadLetterDirective, never, D1> =
  Effect.fn("Deletions.processDeadLetter")(function* (value: unknown) {
    return yield* Schema.decodeUnknownEffect(DeletionMessageSchema)(value).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed({ _tag: "DiscardInvalid" } as const),
        onSuccess: (body) => rescheduleDeadLetter(body).pipe(
          Effect.matchCause({
            onFailure: (cause) => ({
              _tag: "Retry" as const,
              delaySeconds: 300 as const,
              diagnostic: queueFailureDiagnostic(cause, "reschedule-dead-letter"),
            }),
            onSuccess: (scheduled) => ({ _tag: "Acknowledge" as const, scheduled }),
          }),
        ),
      }),
    );
  });

/** Cloudflare Queue host adapter; message ack and retry stay outside Effect. */
export function consumeDeletionQueue(
  batch: MessageBatch<unknown>,
  env: Bindings,
): Promise<void> {
  const deadLetterName = env.DELETION_DLQ_NAME ?? DELETION_DLQ_NAME;
  const primaryName = env.DELETION_QUEUE_NAME ?? DELETION_QUEUE_NAME;
  const queueKind: WorkerQueueKind = batch.queue === deadLetterName
    ? "dead-letter"
    : batch.queue === primaryName
    ? "primary"
    : "unknown";

  return traceWorkerOperation({
    name: "pastekey.deletion.queue.consume",
    trigger: "queue",
    queueKind,
    batchSize: batch.messages.length,
  }, async () => {
    if (queueKind === "dead-letter") {
      await consumeDeadLetters(batch, env);
      return;
    }
    if (queueKind === "primary") {
      await consumePrimaryDeletions(batch, env);
      return;
    }

    console.error("Received ciphertext deletion messages from an unknown queue");
    batch.retryAll({ delaySeconds: 300 });
  });
}

async function consumePrimaryDeletions(
  batch: MessageBatch<unknown>,
  env: Bindings,
) {
  for (const message of batch.messages) {
    const directive = await runWorkerEffect(env, processPrimaryDeletion(message.body));
    switch (directive._tag) {
      case "Acknowledge":
        message.ack();
        break;
      case "DiscardInvalid":
        console.error("Discarding invalid ciphertext deletion message");
        message.ack();
        break;
      case "Retry":
        console.error("Queued ciphertext deletion failed", {
          attempt: message.attempts,
          ...directive.diagnostic,
        });
        message.retry({ delaySeconds: directive.delaySeconds });
        break;
    }
  }
}

async function consumeDeadLetters(
  batch: MessageBatch<unknown>,
  env: Bindings,
) {
  for (const message of batch.messages) {
    const directive = await runWorkerEffect(env, processDeadLetter(message.body));
    switch (directive._tag) {
      case "Acknowledge":
        if (directive.scheduled !== null) {
          console.error("Ciphertext deletion scheduled for another retry cycle", directive.scheduled);
        }
        message.ack();
        break;
      case "DiscardInvalid":
        console.error("Discarding invalid ciphertext deletion dead letter");
        message.ack();
        break;
      case "Retry":
        console.error("Could not persist ciphertext deletion dead letter", {
          attempt: message.attempts,
          ...directive.diagnostic,
        });
        message.retry({ delaySeconds: directive.delaySeconds });
        break;
    }
  }
}

function queueFailureDiagnostic(
  cause: Cause.Cause<QueueProcessingError>,
  fallbackOperation: "delete-ciphertext" | "reschedule-dead-letter",
): QueueFailureDiagnostic {
  return Option.match(Cause.findErrorOption(cause), {
    onNone: () => ({
      errorClass: Cause.hasInterrupts(cause)
        ? "Interrupt" as const
        : Cause.hasDies(cause)
        ? "Defect" as const
        : "UnknownCause" as const,
      operation: fallbackOperation,
      causeClass: safeCauseClass(Cause.squash(cause)),
    }),
    onSome: typedFailureDiagnostic,
  });
}

function typedFailureDiagnostic(error: QueueProcessingError): QueueFailureDiagnostic {
  if (error._tag === "D1Error") {
    return {
      errorClass: error._tag,
      operation: error.operation,
      causeClass: safeCauseClass(error.cause),
    };
  }
  return {
    errorClass: error._tag,
    operation: error.operation,
    causeClass: safeCauseClass(error.cause),
  };
}

function safeCauseClass(cause: unknown): string {
  if (cause instanceof EvalError) return "EvalError";
  if (cause instanceof RangeError) return "RangeError";
  if (cause instanceof ReferenceError) return "ReferenceError";
  if (cause instanceof SyntaxError) return "SyntaxError";
  if (cause instanceof TypeError) return "TypeError";
  if (cause instanceof URIError) return "URIError";
  if (cause instanceof Error) return "Error";
  if (cause === null) return "null";
  return typeof cause;
}

function cycleOf(message: DeletionMessage) {
  return message.cycle ?? 0;
}

export function retryDelayMs(cycle: number) {
  return Math.min(2 ** Math.max(0, cycle - 1) * HOUR_MS, MAX_BACKOFF_MS);
}

import { Effect, Schema } from "effect";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";

import { R2FileStorage } from "../platform/cloudflare";
import { D1, type D1Statement } from "../platform/d1";
import { runWorkerEffect } from "../runtime";
import type { AccountDeletionPayload, Bindings } from "../types";

const OBJECTS_PER_STEP = 100;
const MAX_DELETION_STEPS = 1_000;
const STEP_CONFIG = {
  retries: { limit: 5, delay: "1 minute", backoff: "exponential" },
  timeout: "10 minutes",
} satisfies WorkflowStepConfig;

const DeletionTarget = Schema.Struct({
  id: Schema.String,
  objectKey: Schema.String,
  source: Schema.Literals(["attachment", "job", "reservation"]),
});

const OwnedAccount = Schema.Struct({ id: Schema.String });
const DeletionTargetCount = Schema.Struct({ count: Schema.Number });

class AccountDeletionInvariantError extends Schema.TaggedErrorClass<AccountDeletionInvariantError>()(
  "AccountDeletionInvariantError",
  { message: Schema.String },
) {}

export class AccountDeletionWorkflow extends WorkflowEntrypoint<Bindings, AccountDeletionPayload> {
  async run(event: Readonly<WorkflowEvent<AccountDeletionPayload>>, step: WorkflowStep) {
    const ownsAccount = await step.do("verify deletion ownership", async () =>
      runWorkerEffect(
        this.env,
        ownsAccountDeletion(event.payload.userId, event.instanceId),
      ),
    );
    if (!ownsAccount) return { deleted: false };

    let drained = false;

    for (let batch = 1; batch <= MAX_DELETION_STEPS; batch += 1) {
      const deleted = await step.do(`delete ciphertext batch ${batch}`, STEP_CONFIG, async () =>
        runWorkerEffect(
          this.env,
          deleteCiphertextBatch(event.payload.userId, event.instanceId),
        ),
      );
      if (deleted === 0) {
        drained = true;
        break;
      }
    }

    if (!drained) {
      const remaining = await step.do("verify ciphertext drained", STEP_CONFIG, async () =>
        runWorkerEffect(this.env, countDeletionTargets(event.payload.userId)),
      );
      drained = remaining === 0;
    }
    if (!drained) throw new Error("Account ciphertext exceeds the bounded deletion workflow");

    await step.do("delete account metadata", STEP_CONFIG, async () =>
      runWorkerEffect(
        this.env,
        deleteAccountMetadata(event.payload.userId, event.instanceId),
      ),
    );

    return { deleted: true };
  }
}

const deleteCiphertextBatch = Effect.fn(
  "AccountDeletionWorkflow.deleteCiphertextBatch",
)(function* (userId: string, workflowId: string) {
  if (!(yield* ownsAccountDeletion(userId, workflowId))) return 0;

  const d1 = yield* D1;
  const rows = yield* d1.all(
    d1.bind(
      d1.prepare(
        `SELECT id, objectKey, source FROM (
          SELECT a.id, a.object_key AS objectKey, 'attachment' AS source
          FROM attachments a JOIN pastes p ON p.id = a.paste_id WHERE p.owner_id = ?
          UNION ALL
          SELECT d.id, d.object_key AS objectKey, 'job' AS source
          FROM deletion_jobs d WHERE d.owner_id = ?
          UNION ALL
          SELECT r.id, r.object_key AS objectKey, 'reservation' AS source
          FROM upload_reservations r WHERE r.owner_id = ? AND r.expires_at <= ?
        ) ORDER BY id LIMIT ?`,
      ),
      userId,
      userId,
      userId,
      Date.now(),
      OBJECTS_PER_STEP,
    ),
    DeletionTarget,
  );
  if (rows.results.length === 0) return 0;

  const objectKeys = [...new Set(rows.results.map(({ objectKey }) => objectKey))];
  const storage = yield* R2FileStorage;
  yield* storage.delete(objectKeys);

  const attachmentIds = rows.results
    .filter(({ source }) => source === "attachment")
    .map(({ id }) => id);
  const jobIds = rows.results
    .filter(({ source }) => source === "job")
    .map(({ id }) => id);
  const reservationIds = rows.results
    .filter(({ source }) => source === "reservation")
    .map(({ id }) => id);
  const statements: D1Statement[] = [];
  if (attachmentIds.length > 0) {
    statements.push(
      d1.bind(
        d1.prepare(`DELETE FROM attachments WHERE id IN (${placeholders(attachmentIds)})`),
        ...attachmentIds,
      ),
    );
  }
  if (jobIds.length > 0) {
    statements.push(
      d1.bind(
        d1.prepare(`DELETE FROM deletion_jobs WHERE id IN (${placeholders(jobIds)})`),
        ...jobIds,
      ),
    );
  }
  if (reservationIds.length > 0) {
    statements.push(
      d1.bind(
        d1.prepare(`DELETE FROM upload_reservations WHERE id IN (${placeholders(reservationIds)})`),
        ...reservationIds,
      ),
    );
  }
  yield* d1.batch(statements);
  return objectKeys.length;
});

const ownsAccountDeletion = Effect.fn(
  "AccountDeletionWorkflow.ownsAccountDeletion",
)(function* (userId: string, workflowId: string) {
  const d1 = yield* D1;
  const account = yield* d1.first(
    d1.bind(
      d1.prepare(
        `SELECT id FROM users
         WHERE id = ? AND deletion_workflow_id = ? AND deletion_requested_at IS NOT NULL`,
      ),
      userId,
      workflowId,
    ),
    OwnedAccount,
  );
  return account !== null;
});

const countDeletionTargets = Effect.fn(
  "AccountDeletionWorkflow.countDeletionTargets",
)(function* (userId: string) {
  const d1 = yield* D1;
  const row = yield* d1.first(
    d1.bind(
      d1.prepare(
        `SELECT
          (SELECT COUNT(*) FROM attachments a JOIN pastes p ON p.id = a.paste_id WHERE p.owner_id = ?) +
          (SELECT COUNT(*) FROM deletion_jobs d WHERE d.owner_id = ?) +
          (SELECT COUNT(*) FROM upload_reservations r WHERE r.owner_id = ?) AS count`,
      ),
      userId,
      userId,
      userId,
    ),
    DeletionTargetCount,
  );
  return row?.count ?? 0;
});

const deleteAccountMetadata = Effect.fn(
  "AccountDeletionWorkflow.deleteAccountMetadata",
)(function* (userId: string, workflowId: string) {
  const remaining = yield* countDeletionTargets(userId);
  if (remaining > 0) {
    return yield* AccountDeletionInvariantError.make({
      message: "Account ciphertext deletion is incomplete",
    });
  }

  const d1 = yield* D1;
  const result = yield* d1.run(
    d1.bind(
      d1.prepare(
        "DELETE FROM users WHERE id = ? AND deletion_workflow_id = ? AND deletion_requested_at IS NOT NULL",
      ),
      userId,
      workflowId,
    ),
  );
  if (!result.meta.changes) {
    const user = yield* d1.first(
      d1.bind(d1.prepare("SELECT id FROM users WHERE id = ?"), userId),
      OwnedAccount,
    );
    if (user !== null) {
      return yield* AccountDeletionInvariantError.make({
        message: "Account deletion workflow no longer owns this account",
      });
    }
  }
  return { deleted: true };
});

function placeholders(values: ReadonlyArray<unknown>) {
  return values.map(() => "?").join(",");
}

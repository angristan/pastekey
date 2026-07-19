import { Effect, Result, Schema } from "effect";

import { AccountWorkflow } from "../platform/cloudflare";
import { D1 } from "../platform/d1";
import { runWorkerEffect } from "../runtime";
import type { AccountDeletionPayload, Bindings } from "../types";

const RECONCILIATION_BATCH_SIZE = 25;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 24 * HOUR_MS;

const DeletingAccountRow = Schema.Struct({
  id: Schema.String,
  workflowId: Schema.String,
  recoveryAttempts: Schema.Number,
});
export type DeletingAccountRow = typeof DeletingAccountRow.Type;

const WorkflowInstanceOperation = Schema.Literals(["status", "resume", "restart"]);
type WorkflowInstanceOperation = typeof WorkflowInstanceOperation.Type;

class WorkflowInstanceError extends Schema.TaggedErrorClass<WorkflowInstanceError>()(
  "WorkflowInstanceError",
  {
    operation: WorkflowInstanceOperation,
    cause: Schema.Defect(),
  },
) {}

const workflowInstanceCall = <A>(
  operation: WorkflowInstanceOperation,
  call: () => Promise<A>,
) => Effect.tryPromise({
  try: call,
  catch: (cause) => WorkflowInstanceError.make({ operation, cause }),
});

export function accountDeletionWorkflowId(userId: string) {
  return `account-${userId}`;
}

function workflowOptions(
  userId: string,
  workflowId: string,
): WorkflowInstanceCreateOptions<AccountDeletionPayload> {
  return {
    id: workflowId,
    params: { userId },
    retention: { successRetention: "1 day", errorRetention: "3 days" },
  };
}

export const startAccountDeletionWorkflow = Effect.fn(
  "AccountDeletions.startAccountDeletionWorkflow",
)(function* (userId: string, workflowId: string) {
  const workflow = yield* AccountWorkflow;
  const started = yield* Effect.result(workflow.create(workflowOptions(userId, workflowId)));
  if (Result.isSuccess(started)) return true;

  // A lost RPC response is indistinguishable from a rejected create. The persisted,
  // deterministic instance ID lets reconciliation safely resolve either outcome.
  yield* Effect.sync(() => {
    console.error("Account deletion workflow start is awaiting reconciliation");
  });
  return false;
});

export const requestAccountDeletion = Effect.fn(
  "AccountDeletions.requestAccountDeletion",
)(function* (userId: string, requestedAt = Date.now()) {
  const d1 = yield* D1;
  const workflowId = accountDeletionWorkflowId(userId);
  const results = yield* d1.batch([
    d1.bind(
      d1.prepare(
        `UPDATE users SET deletion_requested_at = ?, deletion_workflow_id = ?
         WHERE id = ? AND deletion_requested_at IS NULL`,
      ),
      requestedAt,
      workflowId,
      userId,
    ),
    d1.bind(d1.prepare("DELETE FROM sessions WHERE user_id = ?"), userId),
    d1.bind(d1.prepare("DELETE FROM auth_challenges WHERE user_id = ?"), userId),
  ]);
  if (!results[0]?.meta.changes) return false;

  yield* startAccountDeletionWorkflow(userId, workflowId);
  return true;
});

const reconcileAccountDeletion = Effect.fn(
  "AccountDeletions.reconcileAccountDeletion",
)(function* (account: DeletingAccountRow) {
  const workflow = yield* AccountWorkflow;
  const inspection = yield* Effect.result(
    Effect.gen(function* () {
      const instance = yield* workflow.get(account.workflowId);
      const status = yield* workflowInstanceCall("status", () => instance.status());
      return { instance, status };
    }),
  );

  if (Result.isFailure(inspection)) {
    yield* startAccountDeletionWorkflow(account.id, account.workflowId);
    return;
  }

  const { instance, status } = inspection.success;
  switch (status.status) {
    case "paused":
      yield* workflowInstanceCall("resume", () => instance.resume());
      return;
    case "errored":
    case "terminated":
    case "complete":
      yield* workflowInstanceCall("restart", () => instance.restart());
      return;
    case "unknown":
      yield* startAccountDeletionWorkflow(account.id, account.workflowId);
      return;
    case "queued":
    case "running":
    case "waiting":
    case "waitingForPause":
      return;
  }
});

export const reconcileAccountDeletionsEffect = Effect.fn(
  "AccountDeletions.reconcileAccountDeletions",
)(function* (now = Date.now()) {
  const d1 = yield* D1;
  const due = yield* d1.all(
    d1.bind(
      d1.prepare(
        `SELECT id, deletion_workflow_id AS workflowId,
          deletion_recovery_attempts AS recoveryAttempts
         FROM users
         WHERE deletion_requested_at IS NOT NULL
           AND deletion_workflow_id IS NOT NULL
           AND deletion_next_recovery_at <= ?
         ORDER BY deletion_next_recovery_at, deletion_requested_at
         LIMIT ?`,
      ),
      now,
      RECONCILIATION_BATCH_SIZE,
    ),
    DeletingAccountRow,
  );

  let reconciled = 0;
  for (const account of due.results) {
    const nextRecoveryAt = now + recoveryDelayMs(account.recoveryAttempts + 1);
    const claim = yield* d1.run(
      d1.bind(
        d1.prepare(
          `UPDATE users SET
            deletion_recovery_attempts = deletion_recovery_attempts + 1,
            deletion_next_recovery_at = ?
           WHERE id = ? AND deletion_workflow_id = ?
             AND deletion_requested_at IS NOT NULL
             AND deletion_next_recovery_at <= ?`,
        ),
        nextRecoveryAt,
        account.id,
        account.workflowId,
        now,
      ),
    );
    if (!claim.meta.changes) continue;

    const outcome = yield* Effect.result(reconcileAccountDeletion(account));
    if (Result.isSuccess(outcome)) {
      reconciled += 1;
      continue;
    }
    yield* Effect.sync(() => {
      console.error("Account deletion workflow reconciliation failed", {
        attempt: account.recoveryAttempts + 1,
      });
    });
  }
  return reconciled;
});

export function reconcileAccountDeletions(env: Bindings, now = Date.now()) {
  return runWorkerEffect(env, reconcileAccountDeletionsEffect(now));
}

export function recoveryDelayMs(attempt: number) {
  return Math.min(2 ** Math.max(0, attempt - 1) * HOUR_MS, MAX_BACKOFF_MS);
}

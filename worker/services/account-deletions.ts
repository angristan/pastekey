import type { AccountDeletionPayload, Bindings } from "../types";

const RECONCILIATION_BATCH_SIZE = 25;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 24 * HOUR_MS;

export type DeletingAccountRow = {
  id: string;
  workflowId: string;
  recoveryAttempts: number;
};

export function accountDeletionWorkflowId(userId: string) {
  return `account-${userId}`;
}

export async function startAccountDeletionWorkflow(env: Bindings, userId: string, workflowId: string) {
  try {
    await env.ACCOUNT_DELETION.create(workflowOptions(userId, workflowId));
    return true;
  } catch {
    // A lost RPC response is indistinguishable from a rejected create. The persisted,
    // deterministic instance ID lets reconciliation safely resolve either outcome.
    console.error("Account deletion workflow start is awaiting reconciliation");
    return false;
  }
}

export async function reconcileAccountDeletions(env: Bindings, now = Date.now()) {
  const due = await env.DB.prepare(
    `SELECT id, deletion_workflow_id AS workflowId,
      deletion_recovery_attempts AS recoveryAttempts
     FROM users
     WHERE deletion_requested_at IS NOT NULL
       AND deletion_workflow_id IS NOT NULL
       AND deletion_next_recovery_at <= ?
     ORDER BY deletion_next_recovery_at, deletion_requested_at
     LIMIT ?`,
  )
    .bind(now, RECONCILIATION_BATCH_SIZE)
    .all<DeletingAccountRow>();

  let reconciled = 0;
  for (const account of due.results) {
    const nextRecoveryAt = now + recoveryDelayMs(account.recoveryAttempts + 1);
    const claim = await env.DB.prepare(
      `UPDATE users SET
        deletion_recovery_attempts = deletion_recovery_attempts + 1,
        deletion_next_recovery_at = ?
       WHERE id = ? AND deletion_workflow_id = ?
         AND deletion_requested_at IS NOT NULL
         AND deletion_next_recovery_at <= ?`,
    )
      .bind(nextRecoveryAt, account.id, account.workflowId, now)
      .run();
    if (!claim.meta.changes) continue;

    try {
      await reconcileAccountDeletion(env, account);
      reconciled += 1;
    } catch {
      console.error("Account deletion workflow reconciliation failed", {
        attempt: account.recoveryAttempts + 1,
      });
    }
  }
  return reconciled;
}

async function reconcileAccountDeletion(env: Bindings, account: DeletingAccountRow) {
  let instance: WorkflowInstance;
  let status: InstanceStatus;
  try {
    instance = await env.ACCOUNT_DELETION.get(account.workflowId);
    status = await instance.status();
  } catch {
    await startAccountDeletionWorkflow(env, account.id, account.workflowId);
    return;
  }

  switch (status.status) {
    case "paused":
      await instance.resume();
      return;
    case "errored":
    case "terminated":
    case "complete":
      await instance.restart();
      return;
    case "unknown":
      await startAccountDeletionWorkflow(env, account.id, account.workflowId);
      return;
    case "queued":
    case "running":
    case "waiting":
    case "waitingForPause":
      return;
  }
}

function workflowOptions(userId: string, workflowId: string): WorkflowInstanceCreateOptions<AccountDeletionPayload> {
  return {
    id: workflowId,
    params: { userId },
    retention: { successRetention: "1 day", errorRetention: "3 days" },
  };
}

export function recoveryDelayMs(attempt: number) {
  return Math.min(2 ** Math.max(0, attempt - 1) * HOUR_MS, MAX_BACKOFF_MS);
}

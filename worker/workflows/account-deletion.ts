import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { AccountDeletionPayload, Bindings } from "../types";

const OBJECTS_PER_STEP = 100;
const MAX_DELETION_STEPS = 1_000;
const STEP_CONFIG = {
  retries: { limit: 5, delay: "1 minute", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

type DeletionTarget = {
  id: string;
  objectKey: string;
  source: "attachment" | "job";
};

export class AccountDeletionWorkflow extends WorkflowEntrypoint<Bindings, AccountDeletionPayload> {
  async run(event: Readonly<WorkflowEvent<AccountDeletionPayload>>, step: WorkflowStep) {
    const ownsAccount = await step.do("verify deletion ownership", async () =>
      Boolean(await ownsAccountDeletion(this.env.DB, event.payload.userId, event.instanceId)),
    );
    if (!ownsAccount) return { deleted: false };

    let drained = false;

    for (let batch = 1; batch <= MAX_DELETION_STEPS; batch += 1) {
      const deleted = await step.do(`delete ciphertext batch ${batch}`, STEP_CONFIG, async () =>
        deleteCiphertextBatch(this.env, event.payload.userId, event.instanceId),
      );
      if (deleted === 0) {
        drained = true;
        break;
      }
    }

    if (!drained) {
      const remaining = await step.do("verify ciphertext drained", STEP_CONFIG, async () =>
        countDeletionTargets(this.env.DB, event.payload.userId),
      );
      drained = remaining === 0;
    }
    if (!drained) throw new Error("Account ciphertext exceeds the bounded deletion workflow");

    await step.do("delete account metadata", STEP_CONFIG, async () => {
      const remaining = await countDeletionTargets(this.env.DB, event.payload.userId);
      if (remaining > 0) throw new Error("Account ciphertext deletion is incomplete");

      const result = await this.env.DB.prepare(
        "DELETE FROM users WHERE id = ? AND deletion_workflow_id = ? AND deletion_requested_at IS NOT NULL",
      )
        .bind(event.payload.userId, event.instanceId)
        .run();
      if (!result.meta.changes) {
        const user = await this.env.DB.prepare("SELECT id FROM users WHERE id = ?")
          .bind(event.payload.userId)
          .first();
        if (user) throw new Error("Account deletion workflow no longer owns this account");
      }
      return { deleted: true };
    });

    return { deleted: true };
  }
}

async function deleteCiphertextBatch(env: Bindings, userId: string, workflowId: string) {
  if (!(await ownsAccountDeletion(env.DB, userId, workflowId))) return 0;

  const rows = await env.DB.prepare(
    `SELECT id, objectKey, source FROM (
      SELECT a.id, a.object_key AS objectKey, 'attachment' AS source
      FROM attachments a JOIN pastes p ON p.id = a.paste_id WHERE p.owner_id = ?
      UNION ALL
      SELECT d.id, d.object_key AS objectKey, 'job' AS source
      FROM deletion_jobs d WHERE d.owner_id = ?
    ) ORDER BY id LIMIT ?`,
  )
    .bind(userId, userId, OBJECTS_PER_STEP)
    .all<DeletionTarget>();
  if (!rows.results.length) return 0;

  const objectKeys = [...new Set(rows.results.map(({ objectKey }) => objectKey))];
  await env.FILES.delete(objectKeys);

  const attachmentIds = rows.results.filter(({ source }) => source === "attachment").map(({ id }) => id);
  const jobIds = rows.results.filter(({ source }) => source === "job").map(({ id }) => id);
  const statements: D1PreparedStatement[] = [];
  if (attachmentIds.length) {
    statements.push(
      env.DB.prepare(`DELETE FROM attachments WHERE id IN (${placeholders(attachmentIds)})`).bind(...attachmentIds),
    );
  }
  if (jobIds.length) {
    statements.push(
      env.DB.prepare(`DELETE FROM deletion_jobs WHERE id IN (${placeholders(jobIds)})`).bind(...jobIds),
    );
  }
  await env.DB.batch(statements);
  return objectKeys.length;
}

function ownsAccountDeletion(db: D1Database, userId: string, workflowId: string) {
  return db.prepare(
    `SELECT id FROM users
     WHERE id = ? AND deletion_workflow_id = ? AND deletion_requested_at IS NOT NULL`,
  )
    .bind(userId, workflowId)
    .first();
}

async function countDeletionTargets(db: D1Database, userId: string) {
  const row = await db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM attachments a JOIN pastes p ON p.id = a.paste_id WHERE p.owner_id = ?) +
      (SELECT COUNT(*) FROM deletion_jobs d WHERE d.owner_id = ?) AS count`,
  )
    .bind(userId, userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function placeholders(values: unknown[]) {
  return values.map(() => "?").join(",");
}

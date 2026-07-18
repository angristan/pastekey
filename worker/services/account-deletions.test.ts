import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accountDeletionWorkflowId,
  reconcileAccountDeletions,
  recoveryDelayMs,
} from "./account-deletions";
import type { Bindings } from "../types";

const bindings = env as unknown as Bindings;
const userId = "reconcileaccount123456";
const workflowId = accountDeletionWorkflowId(userId);

describe("account deletion reconciliation", () => {
  beforeEach(async () => {
    const now = Date.now();
    await bindings.DB.prepare(
      `INSERT INTO users (
        id, created_at, deletion_requested_at, deletion_workflow_id,
        deletion_recovery_attempts, deletion_next_recovery_at
      ) VALUES (?, ?, ?, ?, 0, 0)`,
    )
      .bind(userId, now, now, workflowId)
      .run();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  });

  it("restarts an errored Workflow and persists bounded backoff", async () => {
    const restart = vi.fn(async () => undefined);
    const fakeEnv = workflowEnv({
      get: async () => workflowInstance("errored", { restart }),
    });
    const now = Date.now();

    expect(await reconcileAccountDeletions(fakeEnv, now)).toBe(1);
    expect(restart).toHaveBeenCalledOnce();
    const user = await bindings.DB.prepare(
      `SELECT deletion_recovery_attempts AS attempts,
        deletion_next_recovery_at AS nextRecoveryAt FROM users WHERE id = ?`,
    )
      .bind(userId)
      .first<{ attempts: number; nextRecoveryAt: number }>();
    expect(user).toEqual({ attempts: 1, nextRecoveryAt: now + recoveryDelayMs(1) });
  });

  it("recreates a missing Workflow with its persisted deterministic ID", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const create = vi.fn(async () => ({}) as WorkflowInstance);
    const fakeEnv = workflowEnv({
      get: async () => { throw new Error("missing"); },
      create,
    });

    expect(await reconcileAccountDeletions(fakeEnv)).toBe(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: workflowId,
      params: { userId },
    }));
  });

  it("claims a due account only once across concurrent reconcilers", async () => {
    const get = vi.fn(async () => workflowInstance("running"));
    const fakeEnv = workflowEnv({ get });
    const now = Date.now();

    await Promise.all([
      reconcileAccountDeletions(fakeEnv, now),
      reconcileAccountDeletions(fakeEnv, now),
    ]);

    expect(get).toHaveBeenCalledOnce();
  });
});

function workflowEnv(overrides: Partial<Workflow>) {
  return {
    DB: bindings.DB,
    ACCOUNT_DELETION: {
      create: async () => ({}) as WorkflowInstance,
      get: async () => workflowInstance("running"),
      ...overrides,
    },
  } as unknown as Bindings;
}

function workflowInstance(
  status: InstanceStatus["status"],
  overrides: Partial<WorkflowInstance> = {},
) {
  return {
    id: workflowId,
    status: async () => ({ status }),
    pause: async () => undefined,
    resume: async () => undefined,
    terminate: async () => undefined,
    restart: async () => undefined,
    sendEvent: async () => undefined,
    ...overrides,
  } as unknown as WorkflowInstance;
}

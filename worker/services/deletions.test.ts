import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWorkerEffect } from "../runtime";
import {
  consumeDeletionQueue,
  dispatchPendingAttachmentDeletions,
  recoverStaleDeletions,
  retryDelayMs,
} from "./deletions";
import type { Bindings, DeletionMessage } from "../types";

const bindings = env as unknown as Bindings;
const jobId = "queuefailure1234567890";
const ownerId = "queuefailureowner12345";
const objectKey = `${ownerId}/ciphertext`;

describe("deletion queue failures", () => {
  afterEach(async () => {
    await bindings.DB.prepare("DELETE FROM deletion_jobs WHERE id = ?").bind(jobId).run();
    vi.restoreAllMocks();
  });

  it("retries without losing the durable deletion job", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await bindings.DB.prepare(
      `INSERT INTO deletion_jobs (id, owner_id, object_key, ciphertext_size, created_at, queued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(jobId, ownerId, objectKey, 32, Date.now(), Date.now())
      .run();

    const batch = createMessageBatch<DeletionMessage>("pastekey-deletions", [
      { id: "failed-message", timestamp: new Date(), attempts: 1, body: { jobId, cycle: 0 } },
    ]);
    const context = createExecutionContext();
    const failingEnv = {
      DB: bindings.DB,
      FILES: { delete: async () => { throw new Error("simulated R2 failure"); } },
    } as unknown as Bindings;

    await consumeDeletionQueue(batch, failingEnv);
    const result = await getQueueResult(batch, context);

    expect(result.retryMessages).toHaveLength(1);
    expect(await bindings.DB.prepare("SELECT id FROM deletion_jobs WHERE id = ?").bind(jobId).first()).not.toBeNull();
  });

  it("turns dead letters into delayed retry cycles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    await bindings.DB.prepare(
      `INSERT INTO deletion_jobs (id, owner_id, object_key, ciphertext_size, created_at, queued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(jobId, ownerId, objectKey, 32, now, now)
      .run();

    const batch = createMessageBatch<DeletionMessage>("pastekey-deletions-dlq", [
      { id: "dead-letter", timestamp: new Date(), attempts: 1, body: { jobId, cycle: 0 } },
    ]);
    const context = createExecutionContext();
    await consumeDeletionQueue(batch, bindings);
    const result = await getQueueResult(batch, context);
    const job = await bindings.DB.prepare(
      `SELECT failure_cycles AS failureCycles, queued_at AS queuedAt,
        next_attempt_at AS nextAttemptAt, last_failed_at AS lastFailedAt
       FROM deletion_jobs WHERE id = ?`,
    )
      .bind(jobId)
      .first<{ failureCycles: number; queuedAt: number | null; nextAttemptAt: number; lastFailedAt: number | null }>();

    expect(result.explicitAcks).toContain("dead-letter");
    expect(job).toMatchObject({ failureCycles: 1, queuedAt: null });
    expect(job!.lastFailedAt).toEqual(expect.any(Number));
    expect(job!.nextAttemptAt).toBeGreaterThanOrEqual(now + retryDelayMs(1));
    expect(await runWorkerEffect(
      bindings,
      dispatchPendingAttachmentDeletions(now + 30 * 60 * 1_000),
    )).toBe(0);
  });

  it("recovers dispatches that outlive Queue retention", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Date.now();
    await bindings.DB.prepare(
      `INSERT INTO deletion_jobs (id, owner_id, object_key, ciphertext_size, created_at, queued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(jobId, ownerId, objectKey, 32, now - 26 * 60 * 60 * 1_000, now - 26 * 60 * 60 * 1_000)
      .run();

    expect(await runWorkerEffect(bindings, recoverStaleDeletions(now))).toBe(1);
    const job = await bindings.DB.prepare(
      `SELECT failure_cycles AS failureCycles, queued_at AS queuedAt,
        next_attempt_at AS nextAttemptAt FROM deletion_jobs WHERE id = ?`,
    )
      .bind(jobId)
      .first<{ failureCycles: number; queuedAt: number | null; nextAttemptAt: number }>();

    expect(job).toEqual({ failureCycles: 1, queuedAt: null, nextAttemptAt: now + retryDelayMs(6) });
  });

  it("honors deployment-configured queue names", async () => {
    const batch = createMessageBatch<DeletionMessage>("custom-deletions", [
      { id: "custom-message", timestamp: new Date(), attempts: 1, body: { jobId, cycle: 0 } },
    ]);
    const context = createExecutionContext();
    await consumeDeletionQueue(batch, {
      ...bindings,
      DELETION_QUEUE_NAME: "custom-deletions",
      DELETION_DLQ_NAME: "custom-deletions-dlq",
    });
    const result = await getQueueResult(batch, context);
    expect(result.explicitAcks).toContain("custom-message");
    expect(result.retryMessages).toHaveLength(0);
  });

  it("caps poison-job retries at one cycle per day", () => {
    expect(retryDelayMs(1)).toBe(60 * 60 * 1_000);
    expect(retryDelayMs(4)).toBe(8 * 60 * 60 * 1_000);
    expect(retryDelayMs(100)).toBe(24 * 60 * 60 * 1_000);
  });
});

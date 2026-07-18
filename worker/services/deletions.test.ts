import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeDeletionQueue } from "./deletions";
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
      { id: "failed-message", timestamp: new Date(), attempts: 1, body: { jobId } },
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
});

import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupExpired } from "./cleanup";
import { consumeDeletionQueue } from "./deletions";
import type { Bindings, DeletionMessage } from "../types";

const bindings = env as unknown as Bindings;
const userId = "expiredcleanupuser12345";
const pasteId = "expiredcleanuppaste1234";
const fileId = "expiredcleanupfile12345";
const objectKey = `${userId}/${pasteId}/${fileId}`;

describe("expired ciphertext cleanup", () => {
  afterEach(async () => {
    await bindings.FILES.delete(objectKey);
    await bindings.DB.prepare("DELETE FROM deletion_jobs WHERE owner_id = ?").bind(userId).run();
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  });

  it("moves expired files through the durable deletion queue", async () => {
    const now = Date.now();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
      bindings.DB.prepare(
        `INSERT INTO pastes (
          id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(pasteId, userId, "AA", "AA", "AA", "AA", now, now, now - 1),
      bindings.DB.prepare(
        `INSERT INTO attachments (
          id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
          metadata_ciphertext, metadata_iv, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(fileId, pasteId, objectKey, 32, "AA", "AA", "AA", "AA", "AA", now),
    ]);
    await bindings.FILES.put(objectKey, new Uint8Array(32));

    await cleanupExpired(bindings);

    expect(await bindings.DB.prepare("SELECT id FROM pastes WHERE id = ?").bind(pasteId).first()).toBeNull();
    const job = await bindings.DB.prepare("SELECT queued_at AS queuedAt FROM deletion_jobs WHERE id = ?")
      .bind(fileId)
      .first<{ queuedAt: number | null }>();
    expect(job?.queuedAt).toEqual(expect.any(Number));
    expect(await bindings.FILES.get(objectKey)).not.toBeNull();

    const batch = createMessageBatch<DeletionMessage>("pastekey-deletions", [
      { id: "expired-message", timestamp: new Date(), attempts: 1, body: { jobId: fileId } },
    ]);
    const context = createExecutionContext();
    await consumeDeletionQueue(batch, bindings);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toContain("expired-message");
    expect(await bindings.FILES.get(objectKey)).toBeNull();
  });
});

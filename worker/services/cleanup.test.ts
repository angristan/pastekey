import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { runWorkerEffect } from "../runtime";
import { cleanupExpired, findCleanupCandidates, stageCleanupCandidates } from "./cleanup";
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
    await bindings.DB.prepare("DELETE FROM upload_reservations WHERE owner_id = ?").bind(userId).run();
    await bindings.DB.prepare("DELETE FROM deletion_jobs WHERE owner_id = ?").bind(userId).run();
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  });

  it("rechecks expiry atomically before staging attachment deletion", async () => {
    const now = Date.now();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
      bindings.DB.prepare(
        `INSERT INTO pastes (
          id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv, created_at, updated_at, expires_at
        ) VALUES (?, ?, 'AA', 'AA', 'AA', 'AA', ?, ?, ?)`,
      ).bind(pasteId, userId, now, now, now - 1),
      bindings.DB.prepare(
        `INSERT INTO attachments (
          id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
          metadata_ciphertext, metadata_iv, created_at
        ) VALUES (?, ?, ?, 32, 'AA', 'AA', 'AA', 'AA', 'AA', ?)`,
      ).bind(fileId, pasteId, objectKey, now),
    ]);

    const candidates = await runWorkerEffect(bindings, findCleanupCandidates(now));
    expect(candidates.attachmentIds).toContain(fileId);
    await bindings.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
      .bind(now + 60_000, pasteId)
      .run();
    await runWorkerEffect(bindings, stageCleanupCandidates(candidates, now));

    expect(await bindings.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(fileId).first()).not.toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM deletion_jobs WHERE id = ?").bind(fileId).first()).toBeNull();
  });

  it("drains more than one cleanup batch in a bounded run", async () => {
    const now = Date.now();
    const statements = Array.from({ length: 101 }, (_, index) => {
      const id = `cleanup-batch-${String(index).padStart(8, "0")}`;
      return bindings.DB.prepare(
        `INSERT INTO upload_reservations (
          id, owner_id, paste_id, object_key, ciphertext_size, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 32, ?, ?)`,
      ).bind(id, userId, pasteId, `${objectKey}-${index}`, now - 10_000, now - 1);
    });
    await bindings.DB.batch(statements.slice(0, 100));
    await bindings.DB.batch(statements.slice(100));

    await runWorkerEffect(bindings, cleanupExpired());

    const reservations = await bindings.DB.prepare(
      "SELECT COUNT(*) AS count FROM upload_reservations WHERE owner_id = ?",
    ).bind(userId).first<{ count: number }>();
    const jobs = await bindings.DB.prepare(
      `SELECT COUNT(*) AS count,
        SUM(CASE WHEN queued_at IS NOT NULL THEN 1 ELSE 0 END) AS queued
       FROM deletion_jobs WHERE owner_id = ?`,
    ).bind(userId).first<{ count: number; queued: number }>();
    expect(reservations?.count).toBe(0);
    expect(jobs).toEqual({ count: 101, queued: 101 });
  });

  it("moves abandoned upload reservations through the durable deletion queue", async () => {
    const now = Date.now();
    await bindings.DB.prepare(
      `INSERT INTO upload_reservations (
        id, owner_id, paste_id, object_key, ciphertext_size, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(fileId, userId, pasteId, objectKey, 32, now - 10_000, now - 1)
      .run();
    await bindings.FILES.put(objectKey, new Uint8Array(32));

    await runWorkerEffect(bindings, cleanupExpired());

    expect(await bindings.DB.prepare("SELECT id FROM upload_reservations WHERE id = ?").bind(fileId).first()).toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM deletion_jobs WHERE id = ?").bind(fileId).first()).not.toBeNull();

    const batch = createMessageBatch<DeletionMessage>("pastekey-deletions", [
      { id: "reservation-message", timestamp: new Date(), attempts: 1, body: { jobId: fileId } },
    ]);
    const context = createExecutionContext();
    await consumeDeletionQueue(batch, bindings);
    const result = await getQueueResult(batch, context);

    expect(result.explicitAcks).toContain("reservation-message");
    expect(await bindings.FILES.get(objectKey)).toBeNull();
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

    await runWorkerEffect(bindings, cleanupExpired());

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

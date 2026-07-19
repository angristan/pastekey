import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashToken } from "../lib/encoding";
import { finalizeAttachment, reserveAttachment } from "../repositories/attachments";
import { runWorkerEffect } from "../runtime";
import {
  listAttachmentsForPaste,
  openOwnedAttachment,
} from "../services/attachment-upload";
import { consumeDeletionQueue } from "../services/deletions";
import type { Bindings, DeletionMessage } from "../types";

function isBindings(value: unknown): value is Bindings {
  return typeof value === "object" && value !== null;
}

if (!isBindings(env)) throw new Error("Cloudflare test bindings are unavailable");
const bindings = env;
const userId = "testuser12345678901234";
const pasteId = "testpaste1234567890123";
const fileId = "testfile12345678901234";
const token = "test-session-token-for-attachments";
const objectKey = `${userId}/${pasteId}/${fileId}`;

describe("authenticated attachment routes", () => {
  beforeEach(async () => {
    const now = Date.now();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
      bindings.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await hashToken(token), userId, now, now + 60_000),
      bindings.DB.prepare(
        `INSERT INTO pastes (
          id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).bind(pasteId, userId, "AA", "AA", "AA", "AA", now, now),
    ]);
  });

  afterEach(async () => {
    await bindings.FILES.delete(objectKey);
    await bindings.DB.prepare("DELETE FROM upload_reservations WHERE owner_id = ?").bind(userId).run();
    await bindings.DB.prepare("DELETE FROM deletion_jobs WHERE owner_id = ?").bind(userId).run();
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  });

  it("returns an empty list for an active item without attachments", async () => {
    const response = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/files`, {
      headers: { Cookie: `pk_session=${token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ attachments: [] });
  });

  it("distinguishes missing attachments from missing items", async () => {
    const headers = { Cookie: `pk_session=${token}` };
    const missingFile = await SELF.fetch(
      `https://paste.test/api/pastes/${pasteId}/files/${fileId}/content`,
      { headers },
    );
    expect(missingFile.status).toBe(404);
    await expect(missingFile.json()).resolves.toEqual({ error: "Attachment not found" });

    const missingItem = await SELF.fetch(
      `https://paste.test/api/pastes/missingpaste12345678901/files/${fileId}/content`,
      { headers },
    );
    expect(missingItem.status).toBe(404);
    await expect(missingItem.json()).resolves.toEqual({ error: "Item not found" });
  });

  it("rejects direct attachment queries after account deletion begins", async () => {
    await bindings.DB.prepare(
      "UPDATE users SET deletion_requested_at = ?, deletion_workflow_id = ? WHERE id = ?",
    ).bind(Date.now(), "attachment-query-workflow", userId).run();

    await expect(runWorkerEffect(bindings, listAttachmentsForPaste(pasteId, userId))).resolves.toBeNull();
    await expect(runWorkerEffect(bindings, openOwnedAttachment(pasteId, fileId, userId))).resolves.toEqual({
      status: "item-not-found",
    });
  });

  it("rejects attachment access after the item expires", async () => {
    await bindings.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, pasteId)
      .run();

    const response = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/files`, {
      headers: { Cookie: `pk_session=${token}` },
    });
    expect(response.status).toBe(404);
  });

  it("rejects a file identity reserved by pending deletion", async () => {
    await bindings.DB.prepare(
      `INSERT INTO deletion_jobs (id, owner_id, object_key, ciphertext_size, created_at, queued_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
      .bind(fileId, userId, objectKey, 32, Date.now())
      .run();

    const response = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/files/${fileId}`, {
      method: "PUT",
      headers: {
        Cookie: `pk_session=${token}`,
        "X-Pastekey-Content-IV": "AA",
        "X-Pastekey-Wrapped-Key": "AA",
        "X-Pastekey-Wrapped-Key-IV": "AA",
        "X-Pastekey-Metadata": "AA",
        "X-Pastekey-Metadata-IV": "AA",
      },
      body: new Uint8Array(32),
    });

    expect(response.status).toBe(409);
    expect(await bindings.FILES.get(objectKey)).toBeNull();
  });

  it("rejects finalization after account deletion begins", async () => {
    const reservation = { id: fileId, pasteId, ownerId: userId, objectKey, ciphertextSize: 32 };
    expect((await runWorkerEffect(bindings, reserveAttachment(reservation, {
      maxFilesPerPaste: 10,
      maxStorageBytes: 1024,
    }))).meta.changes).toBe(1);
    await bindings.DB.prepare(
      "UPDATE users SET deletion_requested_at = ?, deletion_workflow_id = ? WHERE id = ?",
    )
      .bind(Date.now(), "account-test-workflow", userId)
      .run();

    const result = await runWorkerEffect(bindings, finalizeAttachment({
      ...reservation,
      contentIv: "AA",
      wrappedKey: "AA",
      wrappedKeyIv: "AA",
      metadataCiphertext: "AA",
      metadataIv: "AA",
      createdAt: Date.now(),
    }));

    expect(result.meta.changes).toBe(0);
    expect(await bindings.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(fileId).first()).toBeNull();
  });

  it("serializes concurrent file and storage quota reservations", async () => {
    const reservations = Array.from({ length: 3 }, (_, index) => ({
      id: `quota-file-000000000${index}`,
      pasteId,
      ownerId: userId,
      objectKey: `${userId}/${pasteId}/quota-${index}`,
      ciphertextSize: 32,
    }));
    const fileResults = await Promise.all(
      reservations.map((reservation) => runWorkerEffect(bindings, reserveAttachment(reservation, {
        maxFilesPerPaste: 2,
        maxStorageBytes: 1024,
      }))),
    );
    expect(fileResults.reduce((sum, result) => sum + result.meta.changes, 0)).toBe(2);

    await bindings.DB.prepare("DELETE FROM upload_reservations WHERE owner_id = ?").bind(userId).run();
    const storageResults = await Promise.all(
      reservations.map((reservation) => runWorkerEffect(bindings, reserveAttachment(reservation, {
        maxFilesPerPaste: 10,
        maxStorageBytes: 64,
      }))),
    );
    expect(storageResults.reduce((sum, result) => sum + result.meta.changes, 0)).toBe(2);
  });

  it("queues individual file deletion without leaving metadata", async () => {
    const now = Date.now();
    await bindings.DB.prepare(
      `INSERT INTO attachments (
        id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
        metadata_ciphertext, metadata_iv, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(fileId, pasteId, objectKey, 32, "AA", "AA", "AA", "AA", "AA", now)
      .run();
    await bindings.FILES.put(objectKey, new Uint8Array(32));

    const response = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/files/${fileId}`, {
      method: "DELETE",
      headers: { Cookie: `pk_session=${token}` },
    });
    expect(response.status).toBe(204);
    expect(await bindings.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(fileId).first()).toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM deletion_jobs WHERE id = ?").bind(fileId).first()).not.toBeNull();
    expect(await bindings.FILES.get(objectKey)).not.toBeNull();
  });

  it("uploads, lists, downloads, and removes opaque ciphertext", async () => {
    const ciphertext = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
    const endpoint = `https://paste.test/api/pastes/${pasteId}/files/${fileId}`;
    const headers = {
      Cookie: `pk_session=${token}`,
      "X-Pastekey-Content-IV": "AA",
      "X-Pastekey-Wrapped-Key": "AA",
      "X-Pastekey-Wrapped-Key-IV": "AA",
      "X-Pastekey-Metadata": "AA",
      "X-Pastekey-Metadata-IV": "AA",
    };

    const upload = await SELF.fetch(endpoint, { method: "PUT", headers, body: ciphertext });
    expect(upload.status).toBe(201);
    await expect(upload.json()).resolves.toMatchObject({ id: fileId });

    const stored = await bindings.FILES.get(objectKey);
    expect(stored?.size).toBe(ciphertext.byteLength);

    const list = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/files`, { headers });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      attachments: [{ id: fileId, ciphertextSize: ciphertext.byteLength }],
    });

    const vaultIndex = await SELF.fetch("https://paste.test/api/attachments", { headers });
    expect(vaultIndex.status).toBe(200);
    await expect(vaultIndex.json()).resolves.toMatchObject({
      attachments: [{ id: fileId, pasteId, ciphertextSize: ciphertext.byteLength }],
    });

    const download = await SELF.fetch(`${endpoint}/content`, { headers });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(ciphertext);

    const remove = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}`, { method: "DELETE", headers });
    expect(remove.status).toBe(204);
    expect(await bindings.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(fileId).first()).toBeNull();
    expect(await bindings.FILES.get(objectKey)).not.toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM deletion_jobs WHERE id = ?").bind(fileId).first()).not.toBeNull();

    const batch = createMessageBatch<DeletionMessage>("pastekey-deletions", [
      { id: "message-1", timestamp: new Date(), attempts: 1, body: { jobId: fileId } },
    ]);
    const context = createExecutionContext();
    await consumeDeletionQueue(batch, bindings);
    const queueResult = await getQueueResult(batch, context);

    expect(queueResult.explicitAcks).toContain("message-1");
    expect(await bindings.FILES.get(objectKey)).toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM deletion_jobs WHERE id = ?").bind(fileId).first()).toBeNull();
  });
});

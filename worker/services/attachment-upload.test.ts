import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWorkerEffect } from "../runtime";
import { uploadAttachment } from "./attachment-upload";
import type { Bindings } from "../types";

function isBindings(value: unknown): value is Bindings {
  return typeof value === "object" && value !== null;
}

if (!isBindings(env)) throw new Error("Cloudflare test bindings are unavailable");
const bindings = env;
const userId = "ambiguous-user-00000001";
const pasteId = "ambiguous-paste-0000001";
const fileId = "ambiguous-file-00000001";
const objectKey = `${userId}/${pasteId}/${fileId}`;

describe("attachment upload finalization", () => {
  beforeEach(async () => {
    const now = Date.now();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
      bindings.DB.prepare(
        `INSERT INTO pastes (
          id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv, created_at, updated_at
        ) VALUES (?, ?, 'AA', 'AA', 'AA', 'AA', ?, ?)`,
      ).bind(pasteId, userId, now, now),
    ]);
  });

  afterEach(async () => {
    await bindings.FILES.delete(objectKey);
    await bindings.DB.prepare("DELETE FROM deletion_jobs WHERE owner_id = ?").bind(userId).run();
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  });

  it("returns typed unavailability when ciphertext storage fails", async () => {
    const storageCause = new Error("R2 unavailable");
    const unavailableFiles = new Proxy(bindings.FILES, {
      get(target, property) {
        if (property === "put") {
          return async () => {
            throw storageCause;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let deletionDispatched = false;

    const result = await runWorkerEffect(
      { ...bindings, FILES: unavailableFiles },
      uploadAttachment(
        {
          pasteId,
          fileId,
          ownerId: userId,
          objectKey,
          ciphertextSize: 32,
          body: new Blob([new Uint8Array(32)]).stream(),
          headers: {
            contentIv: "AA",
            wrappedKey: "AA",
            wrappedKeyIv: "AA",
            metadataCiphertext: "AA",
            metadataIv: "AA",
          },
          limits: { maxFilesPerPaste: 10, maxStorageBytes: 1_024 },
        },
        () => {
          deletionDispatched = true;
        },
      ).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "DomainUnavailableError",
        message: "Encrypted attachment upload failed",
        cause: { _tag: "R2FileStorageError", operation: "put", cause: storageCause },
      });
    }
    expect(deletionDispatched).toBe(true);
    expect(await bindings.FILES.get(objectKey)).toBeNull();
  });

  it("keeps ciphertext when D1 commits but loses the finalize response", async () => {
    const ambiguousDb = new Proxy(bindings.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error("D1 response lost after commit");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const outcome = await runWorkerEffect(
      { ...bindings, DB: ambiguousDb },
      uploadAttachment(
        {
          pasteId,
          fileId,
          ownerId: userId,
          objectKey,
          ciphertextSize: 32,
          body: new Blob([new Uint8Array(32)]).stream(),
          headers: {
            contentIv: "AA",
            wrappedKey: "AA",
            wrappedKeyIv: "AA",
            metadataCiphertext: "AA",
            metadataIv: "AA",
          },
          limits: { maxFilesPerPaste: 10, maxStorageBytes: 1_024 },
        },
        () => undefined,
      ),
    );

    expect(outcome.status).toBe("created");
    expect(await bindings.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(fileId).first()).not.toBeNull();
    expect(await bindings.FILES.get(objectKey)).not.toBeNull();
  });
});

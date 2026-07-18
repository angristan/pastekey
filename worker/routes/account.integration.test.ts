import { env } from "cloudflare:workers";
import { createExecutionContext, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashToken } from "../lib/encoding";
import { accountDeletionWorkflowId, accountRoutes } from "./account";
import type { Bindings } from "../types";

const bindings = env as unknown as Bindings;
const userId = "accountdeleteuser123456";
const pasteId = "accountdeletepaste12345";
const fileId = "accountdeletefile123456";
const shareId = "accountdeleteshare12345";
const token = "account-deletion-session-token";
const objectKey = `${userId}/${pasteId}/${fileId}`;

describe("account deletion workflow", () => {
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
      bindings.DB.prepare(
        `INSERT INTO attachments (
          id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
          metadata_ciphertext, metadata_iv, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(fileId, pasteId, objectKey, 32, "AA", "AA", "AA", "AA", "AA", now),
      bindings.DB.prepare(
        `INSERT INTO shares (id, paste_id, wrapped_key, wrapped_key_iv, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).bind(shareId, pasteId, "AA", "AA", now),
    ]);
    await bindings.FILES.put(objectKey, new Uint8Array(32));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await bindings.FILES.delete(objectKey);
    await bindings.DB.prepare("DELETE FROM deletion_jobs WHERE owner_id = ?").bind(userId).run();
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  });

  it("keeps deletion intent when Workflow creation has an ambiguous failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingBindings = new Proxy(bindings, {
      get(target, property, receiver) {
        if (property === "ACCOUNT_DELETION") {
          return { create: async () => { throw new Error("simulated ambiguous response"); } };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const response = await accountRoutes.fetch(
      new Request("https://paste.test/api/account", {
        method: "DELETE",
        headers: { Cookie: `pk_session=${token}` },
      }),
      failingBindings,
      createExecutionContext(),
    );

    expect(response.status).toBe(202);
    const user = await bindings.DB.prepare(
      "SELECT deletion_requested_at AS requestedAt, deletion_workflow_id AS workflowId FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ requestedAt: number | null; workflowId: string | null }>();
    expect(user?.requestedAt).toEqual(expect.any(Number));
    expect(user?.workflowId).toBe(accountDeletionWorkflowId(userId));
    expect(await bindings.DB.prepare("SELECT id FROM sessions WHERE user_id = ?").bind(userId).first()).toBeNull();
  });

  it("revokes access, deletes R2 ciphertext, and removes account metadata", async () => {
    const workflow = await introspectWorkflow(bindings.ACCOUNT_DELETION);
    try {
      const sharedBefore = await SELF.fetch(`https://paste.test/api/shares/${shareId}`);
      expect(sharedBefore.status).toBe(200);

      const response = await SELF.fetch("https://paste.test/api/account", {
        method: "DELETE",
        headers: { Cookie: `pk_session=${token}` },
      });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ status: "deleting" });

      const me = await SELF.fetch("https://paste.test/api/auth/me", {
        headers: { Cookie: `pk_session=${token}` },
      });
      await expect(me.json()).resolves.toEqual({ authenticated: false });

      const sharedAfter = await SELF.fetch(`https://paste.test/api/shares/${shareId}`);
      expect(sharedAfter.status).toBe(404);

      const instances = await workflow.get();
      expect(instances).toHaveLength(1);
      await instances[0]!.waitForStatus("complete");
      await expect(instances[0]!.getOutput()).resolves.toEqual({ deleted: true });

      expect(await bindings.FILES.get(objectKey)).toBeNull();
      expect(await bindings.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first()).toBeNull();
      expect(await bindings.DB.prepare("SELECT id FROM pastes WHERE id = ?").bind(pasteId).first()).toBeNull();
    } finally {
      await workflow.dispose();
    }
  });
});

import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { hashToken } from "../lib/encoding";
import type { Bindings } from "../types";

const bindings = env as unknown as Bindings;

describe("concurrent account invariants", () => {
  const userId = "invariantuser1234567890";
  const token = "invariant-session-token";

  afterEach(async () => {
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  });

  it("allows only one item creation at the remaining quota slot", async () => {
    const now = Date.now();
    const pasteStatements = Array.from({ length: 99 }, (_, index) =>
      bindings.DB.prepare(
        `INSERT INTO pastes (
          id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, 'AA', 'AA', 'AA', 'AA', ?, ?, NULL)`,
      ).bind(`quota-paste-${String(index).padStart(10, "0")}`, userId, now, now),
    );
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
      bindings.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await hashToken(token), userId, now, now + 60_000),
      ...pasteStatements,
    ]);

    const create = (id: string) => SELF.fetch("https://paste.test/api/pastes", {
      method: "POST",
      headers: { Cookie: `pk_session=${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        ciphertext: "AA",
        contentIv: "AA",
        wrappedKey: "AA",
        wrappedKeyIv: "AA",
        expiresAt: null,
      }),
    });
    const responses = await Promise.all([
      create("quota-new-paste-000001"),
      create("quota-new-paste-000002"),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 413]);
    const count = await bindings.DB.prepare("SELECT COUNT(*) AS count FROM pastes WHERE owner_id = ?")
      .bind(userId)
      .first<{ count: number }>();
    expect(count?.count).toBe(100);
  });

  it("preserves one passkey across concurrent deletion requests", async () => {
    const now = Date.now();
    const credential = (id: string) => bindings.DB.prepare(
      `INSERT INTO credentials (
        id, user_id, public_key, counter, transports, device_type, backed_up,
        wrapped_account_key, wrapped_account_key_iv, created_at
      ) VALUES (?, ?, 'AA', 0, '[]', 'singleDevice', 0, 'AA', 'AA', ?)`,
    ).bind(id, userId, now);
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, now),
      bindings.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await hashToken(token), userId, now, now + 60_000),
      credential("credential-one-000001"),
      credential("credential-two-000002"),
    ]);

    const options = await SELF.fetch("https://paste.test/api/auth/login/options", {
      method: "POST",
      headers: { Cookie: `pk_session=${token}` },
    });
    const optionsBody = await options.json() as { allowCredentials?: { id: string }[] };
    expect(optionsBody.allowCredentials?.map(({ id }) => id).sort()).toEqual([
      "credential-one-000001",
      "credential-two-000002",
    ]);

    const remove = (id: string) => SELF.fetch(`https://paste.test/api/auth/passkeys/${id}`, {
      method: "DELETE",
      headers: { Cookie: `pk_session=${token}` },
    });
    const responses = await Promise.all([
      remove("credential-one-000001"),
      remove("credential-two-000002"),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([204, 409]);
    const count = await bindings.DB.prepare("SELECT COUNT(*) AS count FROM credentials WHERE user_id = ?")
      .bind(userId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});

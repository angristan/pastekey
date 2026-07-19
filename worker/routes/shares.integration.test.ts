import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashToken } from "../lib/encoding";
import type { Bindings } from "../types";

const bindings = env as unknown as Bindings;
const userId = "shareuser1234567890123";
const pasteId = "sharepaste123456789012";
const shareId = "sharelink1234567890123";
const fileId = "sharefile1234567890123";
const objectKey = `${userId}/${pasteId}/${fileId}`;
const token = "test-session-token-for-shares";
const authHeaders = { Cookie: `pk_session=${token}` };

describe("share-link routes", () => {
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
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  });

  it("rejects share management after the item expires", async () => {
    await bindings.DB.prepare(
      "INSERT INTO shares (id, paste_id, wrapped_key, wrapped_key_iv, created_at, expires_at) VALUES (?, ?, 'AA', 'AA', ?, NULL)",
    ).bind(shareId, pasteId, Date.now()).run();
    await bindings.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, pasteId)
      .run();

    const list = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/shares`, { headers: authHeaders });
    expect(list.status).toBe(404);

    const create = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/shares`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "another-share-00000001", wrappedKey: "AA", wrappedKeyIv: "AA" }),
    });
    expect(create.status).toBe(404);

    const revoke = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/shares/${shareId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(revoke.status).toBe(404);
  });

  it("streams encrypted shared attachments through the Worker runtime", async () => {
    const now = Date.now();
    const ciphertext = new Uint8Array(32).fill(7);
    await bindings.DB.batch([
      bindings.DB.prepare(
        "INSERT INTO shares (id, paste_id, wrapped_key, wrapped_key_iv, created_at, expires_at) VALUES (?, ?, 'AA', 'AA', ?, NULL)",
      ).bind(shareId, pasteId, now),
      bindings.DB.prepare(
        `INSERT INTO attachments (
          id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key,
          wrapped_key_iv, metadata_ciphertext, metadata_iv, created_at
        ) VALUES (?, ?, ?, ?, 'AA', 'AA', 'AA', 'AA', 'AA', ?)`,
      ).bind(fileId, pasteId, objectKey, ciphertext.byteLength, now),
    ]);
    await bindings.FILES.put(objectKey, ciphertext);

    const response = await SELF.fetch(
      `https://paste.test/api/shares/${shareId}/files/${fileId}/content`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ciphertext);
  });

  it("creates, lists, reads, and revokes an encrypted link", async () => {
    const create = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/shares`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id: shareId, wrappedKey: "AA", wrappedKeyIv: "AA", expiresAt: null }),
    });
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({ id: shareId });

    const list = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/shares`, { headers: authHeaders });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ shares: [{ id: shareId, expiresAt: null }] });

    const shared = await SELF.fetch(`https://paste.test/api/shares/${shareId}`);
    expect(shared.status).toBe(200);
    await expect(shared.json()).resolves.toMatchObject({ id: shareId, pasteId, attachments: [] });

    const revoke = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/shares/${shareId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(revoke.status).toBe(204);
    await revoke.arrayBuffer();

    const empty = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}/shares`, { headers: authHeaders });
    await expect(empty.json()).resolves.toEqual({ shares: [] });

    const revoked = await SELF.fetch(`https://paste.test/api/shares/${shareId}`);
    expect(revoked.status).toBe(404);
    await revoked.arrayBuffer();
  });
});

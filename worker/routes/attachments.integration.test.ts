import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashToken } from "../lib/encoding";
import type { Bindings } from "../types";

const bindings = env as unknown as Bindings;
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
    await bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
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

    const download = await SELF.fetch(`${endpoint}/content`, { headers });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(ciphertext);

    const remove = await SELF.fetch(`https://paste.test/api/pastes/${pasteId}`, { method: "DELETE", headers });
    expect(remove.status).toBe(204);
    expect(await bindings.FILES.get(objectKey)).toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(fileId).first()).toBeNull();
  });
});

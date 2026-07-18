import type { PasteWrite } from "../../shared/protocol/pastes";
import { serviceLimits } from "../lib/config";
import { throwUniqueConflict } from "../lib/errors";
import { updateActiveOwnedPaste } from "../repositories/pastes";
import type { Bindings } from "../types";

export type CreatePasteOutcome =
  | { status: "created"; createdAt: number }
  | { status: "account-unavailable" }
  | { status: "quota-reached" };

export async function createPaste(
  env: Bindings,
  ownerId: string,
  write: PasteWrite,
  now = Date.now(),
): Promise<CreatePasteOutcome> {
  let inserted: D1Result;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO pastes (
        id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv,
        created_at, updated_at, expires_at
      )
      SELECT ?, u.id, ?, ?, ?, ?, ?, ?, ?
      FROM users u
      WHERE u.id = ? AND u.deletion_requested_at IS NULL
        AND (SELECT COUNT(*) FROM pastes WHERE owner_id = u.id) < ?`,
    )
      .bind(
        write.id,
        write.ciphertext,
        write.contentIv,
        write.wrappedKey,
        write.wrappedKeyIv,
        now,
        now,
        write.expiresAt ?? null,
        ownerId,
        serviceLimits(env).maxPastesPerUser,
      )
      .run();
  } catch (cause) {
    throwUniqueConflict(cause, "Item ID already exists");
  }
  if (inserted.meta.changes) return { status: "created", createdAt: now };

  const active = await env.DB.prepare(
    "SELECT id FROM users WHERE id = ? AND deletion_requested_at IS NULL",
  ).bind(ownerId).first();
  return active ? { status: "quota-reached" } : { status: "account-unavailable" };
}

export function updatePaste(
  db: D1Database,
  pasteId: string,
  ownerId: string,
  write: Omit<PasteWrite, "id">,
  now = Date.now(),
) {
  return updateActiveOwnedPaste(db, pasteId, ownerId, write, now, write.expiresAt ?? null);
}

export async function deletePaste(
  db: D1Database,
  pasteId: string,
  ownerId: string,
  now = Date.now(),
) {
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO deletion_jobs (
        id, owner_id, object_key, ciphertext_size, created_at, queued_at
      )
      SELECT a.id, p.owner_id, a.object_key, a.ciphertext_size, ?, NULL
      FROM attachments a JOIN pastes p ON p.id = a.paste_id
      WHERE p.id = ? AND p.owner_id = ?`,
    ).bind(now, pasteId, ownerId),
    db.prepare("DELETE FROM pastes WHERE id = ? AND owner_id = ?").bind(pasteId, ownerId),
  ]);
  return Boolean(results[1]?.meta.changes);
}

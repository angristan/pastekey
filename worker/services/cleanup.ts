import type { Bindings } from "../types";
import { enqueuePendingDeletions, stageDeletion } from "./deletions";

const EXPIRY_BATCH_SIZE = 100;

export async function cleanupExpired(env: Bindings) {
  const now = Date.now();
  const expired = await env.DB.prepare(
    `SELECT a.id, p.owner_id AS ownerId, a.object_key AS objectKey,
      a.ciphertext_size AS ciphertextSize
     FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE p.expires_at IS NOT NULL AND p.expires_at <= ?
     ORDER BY p.expires_at, a.created_at LIMIT ?`,
  )
    .bind(now, EXPIRY_BATCH_SIZE)
    .all<{ id: string; ownerId: string; objectKey: string; ciphertextSize: number }>();

  await env.DB.batch([
    ...expired.results.flatMap((item) => [
      stageDeletion(env.DB, item, now),
      env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(item.id),
    ]),
    env.DB.prepare(
      `DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= ?
       AND NOT EXISTS (SELECT 1 FROM attachments WHERE attachments.paste_id = pastes.id)`,
    ).bind(now),
    env.DB.prepare("DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
  ]);

  await enqueuePendingDeletions(env);
}

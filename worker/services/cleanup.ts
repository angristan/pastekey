import type { Bindings } from "../types";

export async function cleanupExpired(env: Bindings) {
  const now = Date.now();
  const expired = await env.DB.prepare(
    `SELECT a.id, a.object_key AS objectKey FROM attachments a JOIN pastes p ON p.id = a.paste_id
     WHERE p.expires_at IS NOT NULL AND p.expires_at <= ? LIMIT 100`,
  )
    .bind(now)
    .all<{ id: string; objectKey: string }>();

  if (expired.results.length) {
    await env.FILES.delete(expired.results.map((item) => item.objectKey));
    const placeholders = expired.results.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${placeholders})`)
      .bind(...expired.results.map((item) => item.id))
      .run();
  }

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= ?
       AND NOT EXISTS (SELECT 1 FROM attachments WHERE attachments.paste_id = pastes.id)`,
    ).bind(now),
    env.DB.prepare("DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
  ]);
}

import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const bindings = env as typeof env & {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

describe("populated schema upgrades", () => {
  it("upgrades a populated 0004 database through the latest migration", async () => {
    await resetDatabase(bindings.DB);
    const firstFour = bindings.TEST_MIGRATIONS.slice(0, 4);
    const remaining = bindings.TEST_MIGRATIONS.slice(4);
    expect(firstFour.at(-1)?.name).toContain("0004");
    await applyD1Migrations(bindings.DB, firstFour, "upgrade_migrations");

    const now = Date.now();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO users (id, created_at) VALUES ('upgrade-user', ?)").bind(now),
      bindings.DB.prepare(
        `INSERT INTO credentials (
          id, user_id, public_key, counter, transports, device_type, backed_up,
          wrapped_account_key, wrapped_account_key_iv, created_at
        ) VALUES ('upgrade-credential', 'upgrade-user', 'AA', 0, '[]', 'singleDevice', 0, 'AA', 'AA', ?)`,
      ).bind(now),
      bindings.DB.prepare(
        `INSERT INTO pastes (
          id, owner_id, ciphertext, content_iv, wrapped_key, wrapped_key_iv, created_at, updated_at
        ) VALUES ('upgrade-paste', 'upgrade-user', 'AA', 'AA', 'AA', 'AA', ?, ?)`,
      ).bind(now, now),
      bindings.DB.prepare(
        `INSERT INTO attachments (
          id, paste_id, object_key, ciphertext_size, content_iv, wrapped_key, wrapped_key_iv,
          metadata_ciphertext, metadata_iv, created_at
        ) VALUES ('upgrade-file', 'upgrade-paste', 'upgrade/object', 32, 'AA', 'AA', 'AA', 'AA', 'AA', ?)`,
      ).bind(now),
      bindings.DB.prepare(
        `INSERT INTO deletion_jobs (
          id, owner_id, object_key, ciphertext_size, created_at, queued_at
        ) VALUES ('upgrade-job', 'upgrade-user', 'upgrade/deletion', 32, ?, NULL)`,
      ).bind(now),
    ]);

    await applyD1Migrations(bindings.DB, remaining, "upgrade_migrations");

    const user = await bindings.DB.prepare(
      `SELECT id, deletion_recovery_attempts AS attempts,
        deletion_next_recovery_at AS nextRecoveryAt FROM users WHERE id = 'upgrade-user'`,
    ).first<{ id: string; attempts: number; nextRecoveryAt: number }>();
    expect(user).toEqual({ id: "upgrade-user", attempts: 0, nextRecoveryAt: 0 });
    expect(await bindings.DB.prepare("SELECT id FROM attachments WHERE id = 'upgrade-file'").first())
      .not.toBeNull();
    expect(await bindings.DB.prepare("SELECT id FROM deletion_jobs WHERE id = 'upgrade-job'").first())
      .not.toBeNull();

    await bindings.DB.prepare(
      `INSERT INTO upload_reservations (
        id, owner_id, paste_id, object_key, ciphertext_size, created_at, expires_at
      ) VALUES ('upgrade-reservation', 'upgrade-user', 'upgrade-paste', 'upgrade/reservation', 32, ?, ?)`,
    ).bind(now, now + 60_000).run();
    const foreignKeys = await bindings.DB.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeys.results).toEqual([]);
  });
});

async function resetDatabase(db: D1Database) {
  await db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS upload_reservations;
    DROP TABLE IF EXISTS deletion_jobs;
    DROP TABLE IF EXISTS attachments;
    DROP TABLE IF EXISTS shares;
    DROP TABLE IF EXISTS pastes;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS auth_challenges;
    DROP TABLE IF EXISTS credentials;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS d1_migrations;
    DROP TABLE IF EXISTS upgrade_migrations;
    PRAGMA foreign_keys = ON;
  `);
}

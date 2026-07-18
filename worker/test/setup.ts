import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";

const bindings = env as typeof env & {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname),
        },
      },
    })),
  ],
  test: {
    include: ["src/**/*.test.ts", "worker/**/*.test.ts"],
    setupFiles: ["./worker/test/setup.ts"],
  },
});

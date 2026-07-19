import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Flagship has no local simulator; route tests inject deterministic evaluations.
          FLAGS: {},
          TEST_MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname),
        },
      },
    })),
  ],
  test: {
    name: "worker",
    include: ["worker/**/*.test.ts"],
    setupFiles: ["./worker/test/setup.ts"],
  },
});

import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Wrangler reads required secrets from process.env when loading the config.
process.env.AWS_ACCESS_KEY_ID ??= "test-access-key";

process.env.AWS_SECRET_ACCESS_KEY ??= "test-secret-key";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "migrations")
      );

      return {
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});

import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Wrangler reads required secrets from process.env when loading the config.
process.env.AWS_ACCESS_KEY_ID ??= "test-access-key";

process.env.AWS_SECRET_ACCESS_KEY ??= "test-secret-key";

process.env.TOKEN_SECRET ??= "test-token-secret-at-least-32-characters";

process.env.TURNSTILE_SECRET_KEY ??= "test-turnstile-secret";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "migrations")
      );

      return {
        miniflare: {
          bindings: {
            PUBLIC_URL: "https://news.example.com",
            SES_EVENTS_TOPIC_ARN:
              "arn:aws:sns:us-east-1:123456789012:sendoff-events",
            TEST_MIGRATIONS: migrations,
            TURNSTILE_SITE_KEY: "test-site-key",
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});

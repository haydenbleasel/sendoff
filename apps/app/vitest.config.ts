import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Fixed test values. They're bindings (which override .dev.vars) so tests
// never depend on a developer's local secrets; process.env just stops
// Wrangler warning that required secrets are missing.
const secrets = {
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  MCP_TOKEN: "test-mcp-token-that-is-at-least-32-characters",
  TOKEN_SECRET: "test-token-secret-at-least-32-characters",
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
};

Object.assign(process.env, secrets);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "migrations")
      );

      return {
        miniflare: {
          bindings: {
            ...secrets,
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

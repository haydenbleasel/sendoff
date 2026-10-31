import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createApiKey, listApiKeys, revokeApiKey } from "../api-keys";
import type { ApiKey } from "../api-keys";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { apiScopes } from "../db/schema";
import type { JsonObject } from "../json";
import { result, run } from "./results";

const READ_ONLY = { idempotentHint: true, readOnlyHint: true } as const;

const present = (key: ApiKey): JsonObject => ({
  createdAt: key.createdAt.toISOString(),
  id: key.id,
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  name: key.name,
  prefix: key.prefix,
  revokedAt: key.revokedAt?.toISOString() ?? null,
  scopes: key.scopes,
});

export const registerKeyTools = (
  server: McpServer,
  { config, db }: { config: Config; db: Database }
): void => {
  server.registerTool(
    "create_api_key",
    {
      description: `Create a key for the REST API (${config.publicUrl}/api/v1, described at /api/v1/openapi.json). The key is shown once; tell the person to store it as a server-side secret (e.g. an environment variable), never in browser code. Scope subscribers:write lets a website's signup form call POST /api/v1/subscribers. Scope subscribers:import allows POST /api/v1/subscribers/import, which adds people without confirmation emails: create it only for a one-off import, on its own, and revoke it afterwards.`,
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            'What will use the key, e.g. "haydenbleasel.com signup form".'
          ),
        scopes: z
          .array(z.enum(apiScopes))
          .min(1)
          .optional()
          .describe("Defaults to subscribers:write."),
      }),
      title: "Create API key",
    },
    async ({ name, scopes = ["subscribers:write"] }) =>
      await run(async () => {
        const { apiKey, key } = await createApiKey(db, { name, scopes });

        return result(
          [
            `Created "${apiKey.name}" with ${apiKey.scopes.join(", ")}. This is the only time the key is shown:`,
            key,
            `Use it from a server as \`Authorization: Bearer <key>\`, for example POST ${config.publicUrl}/api/v1/subscribers with {"email": "..."}. Revoke it with revoke_api_key and prefix ${apiKey.prefix}.`,
          ].join("\n\n"),
          present(apiKey)
        );
      })
  );

  server.registerTool(
    "list_api_keys",
    {
      annotations: READ_ONLY,
      description:
        "List REST API keys by name, prefix, scopes and when each was last used. Keys themselves can't be shown again.",
      inputSchema: z.object({}),
      title: "List API keys",
    },
    async () =>
      await run(async () => {
        const keys = await listApiKeys(db);

        return keys.length === 0
          ? result("No API keys yet. Create one with create_api_key.")
          : result(
              `${keys.length} API key${keys.length === 1 ? "" : "s"}.`,
              keys.map((key) => present(key))
            );
      })
  );

  server.registerTool(
    "revoke_api_key",
    {
      annotations: { destructiveHint: true, idempotentHint: true },
      description:
        "Revoke an API key by its id or prefix. Anything using it stops working immediately.",
      inputSchema: z.object({
        key: z.string().min(1).describe("The key's id or prefix."),
      }),
      title: "Revoke API key",
    },
    async ({ key: ref }) =>
      await run(async () => {
        const key = await revokeApiKey(db, ref);

        return result(`Revoked "${key.name}" (${key.prefix}).`, present(key));
      })
  );
};

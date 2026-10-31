import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";

import { getConfig } from "../config";
import { createDb } from "../db/client";
import { createMcpServer } from "../mcp/server";

const HTTP_UNAUTHORIZED = 401;
const BEARER = /^Bearer\s+(?<token>.+)$/iu;

const digest = async (value: string): Promise<ArrayBuffer> =>
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

/** Compare digests so the check takes the same time whatever the token length. */
const tokenMatches = async (
  provided: string,
  expected: string
): Promise<boolean> =>
  crypto.subtle.timingSafeEqual(await digest(provided), await digest(expected));

export const mcpRoutes = new Hono<{ Bindings: Env }>();

mcpRoutes.all("/mcp", async (c) => {
  const config = getConfig(c.env);

  const token =
    BEARER.exec(c.req.header("authorization") ?? "")?.groups?.token ?? "";

  if (!(await tokenMatches(token, config.mcpToken))) {
    return c.json(
      { error: "Missing or invalid bearer token." },
      HTTP_UNAUTHORIZED,
      { "WWW-Authenticate": 'Bearer realm="sendoff"' }
    );
  }

  const db = createDb(c.env.DB);

  const handler = createMcpHandler(() => createMcpServer({ config, db }), {
    onerror: (error) => console.error("MCP error", error),
    responseMode: "json",
  });

  return await handler.fetch(c.req.raw);
});

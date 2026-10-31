import { createMcpHandler } from "@modelcontextprotocol/server";

import { getConfig } from "../config";
import { createDb } from "../db/client";
import { createMcpServer } from "../mcp/server";

/**
 * Serve one MCP request. Auth happens before this: the OAuth provider
 * (index.ts) accepts either an OAuth access token or the static MCP_TOKEN.
 */
export const handleMcp = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const config = getConfig(env);
  const db = createDb(env.DB);

  const handler = createMcpHandler(
    () => createMcpServer({ config, db, queue: env.SEND_QUEUE }),
    {
      onerror: (error) => console.error("MCP error", error),
      responseMode: "json",
    }
  );

  return await handler.fetch(request);
};

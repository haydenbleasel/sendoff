import { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config";
import type { Database } from "../db/client";
import { registerDraftTools } from "./draft-tools";
import { INSTRUCTIONS } from "./instructions";
import { registerSettingsTools } from "./settings-tools";
import { registerSubscriberTools } from "./subscriber-tools";

export const SERVER_INFO = { name: "sendoff", version: "0.1.0" } as const;

/** A fresh server per request: the Worker is stateless between MCP calls. */
export const createMcpServer = (deps: {
  config: Config;
  db: Database;
}): McpServer => {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  registerSettingsTools(server, deps);
  registerDraftTools(server, deps);
  registerSubscriberTools(server, deps);

  return server;
};

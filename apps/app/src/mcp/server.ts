import { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config";
import type { Database } from "../db/client";
import type { SendQueue } from "../sending";
import { registerDraftTools } from "./draft-tools";
import { INSTRUCTIONS } from "./instructions";
import { registerSendTools } from "./send-tools";
import { registerSettingsTools } from "./settings-tools";
import { registerSubscriberTools } from "./subscriber-tools";

export const SERVER_INFO = { name: "sendoff", version: "0.1.0" } as const;

/** A fresh server per request: the Worker is stateless between MCP calls. */
export const createMcpServer = (deps: {
  config: Config;
  db: Database;
  queue: SendQueue;
}): McpServer => {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  registerSettingsTools(server, deps);
  registerDraftTools(server, deps);
  registerSubscriberTools(server, deps);
  registerSendTools(server, deps);

  return server;
};

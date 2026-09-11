import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./types.ts";
import { isScopeActive, loadConfig } from "./config.ts";
import { registerTools } from "./tools.ts";

export const SERVER_NAME = "apple-messages";
export const SERVER_VERSION = "0.2.0";

export function createServer(config: Config = loadConfig()): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    title: "Apple Messages",
    description: [
      "Local Apple Messages / iMessage connector. All reads stay on this Mac.",
      isScopeActive(config)
        ? config.scope.length > 0
          ? `MESSAGES_SCOPE is active (${config.scope.join(", ")}).`
          : "Scoped shut: set MESSAGES_SCOPE or MESSAGES_ALLOW_UNSCOPED=1."
        : "MESSAGES_ALLOW_UNSCOPED=1: every readable chat is available.",
      "Call messages_status first if a tool fails.",
      "Do not echo full threads into logs or remote systems.",
      config.enableSend
        ? "Send is ENABLED. Confirm recipient and body with the user before messages_send."
        : "Send is disabled (ENABLE_SEND is not set).",
    ].join(" "),
  });
  registerTools(server, config);
  return server;
}

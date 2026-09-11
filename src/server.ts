import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./types.ts";
import { isScopeActive, loadConfig } from "./config.ts";
import { registerTools } from "./tools.ts";

export const SERVER_NAME = "apple-messages";
export const SERVER_VERSION = "0.1.0";

export function createServer(config: Config = loadConfig()): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    title: "Apple Messages",
    description: [
      "Local Apple Messages / iMessage connector. All reads stay on this Mac.",
      isScopeActive(config)
        ? `Optional allowlist is active (${[config.scopeDisplayName, config.scopeChatId, ...config.scopeAllowlist]
            .filter((v) => v !== null && v !== "")
            .join(", ")}).`
        : "Unscoped: every readable chat is available unless the host sets MESSAGES_SCOPE_*.",
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

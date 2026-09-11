#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isScopeActive, loadConfig } from "./config.ts";
import { logInfo } from "./log.ts";
import { createServer } from "./server.ts";
import { CLI_COMMANDS, runCli } from "./cli.ts";

async function runMcp(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo("listening", {
    dbMode: config.dbMode,
    send: config.enableSend,
    scoped: isScopeActive(config),
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command && CLI_COMMANDS.has(command)) {
    await runCli(argv);
    return;
  }
  if (command) {
    await runCli(["help"]);
    process.exit(1);
  }
  await runMcp();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[apple-messages-mcp] fatal: ${message}`);
  process.exit(1);
});

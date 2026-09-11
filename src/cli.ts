import { loadConfig } from "./config.ts";
import {
  actionGetThread,
  actionListChats,
  actionSearch,
  actionSend,
  actionStatus,
} from "./actions.ts";
import { MessagesError } from "./types.ts";
import { runWatcher } from "./watch/poll.ts";

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function fail(err: unknown): never {
  if (err instanceof MessagesError) {
    printJson({ error: { code: err.code, message: err.message } });
  } else {
    const message = err instanceof Error ? err.message : String(err);
    printJson({ error: { code: "OPEN_FAILED", message } });
  }
  process.exit(1);
}

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function usage(): string {
  return `apple-messages-mcp

  (no args)              start MCP stdio server
  status                 messages_status
  list [--query TEXT]    messages_list_chats
  thread [--chat-id N] [--handle ADDR] [--limit N] [--before ID|ISO]
  search QUERY
  send --to NAME --body TEXT --confirm [--dry-run]   (needs ENABLE_SEND=1)
  watch [--interval MS]  Phase 2 JSON-line wake hook (not MCP)

Env: MESSAGES_DB_PATH, ENABLE_SEND, REDACT_PREVIEWS,
     MESSAGES_SCOPE, MESSAGES_ALLOW_UNSCOPED,
     MESSAGES_WAKE_HOOK, WATCH_INCLUDE_PREVIEW
`;
}

type CliCommand =
  | "help"
  | "--help"
  | "-h"
  | "status"
  | "list"
  | "thread"
  | "search"
  | "send"
  | "watch";

export const CLI_COMMANDS = new Set<string>([
  "help",
  "--help",
  "-h",
  "status",
  "list",
  "thread",
  "search",
  "send",
  "watch",
]);

function asCliCommand(value: string | undefined): CliCommand | null {
  if (!value) return null;
  if (CLI_COMMANDS.has(value)) return value as CliCommand;
  return null;
}

export async function runCli(argv: string[]): Promise<void> {
  const command = asCliCommand(argv[0]);
  const config = loadConfig();

  try {
    if (command === null) {
      process.stderr.write(usage());
      throw new MessagesError("INVALID_ARGS", `Unknown command: ${argv[0] ?? ""}`);
    }
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(usage());
        return;
      case "status":
        printJson(actionStatus(config));
        return;
      case "list":
        printJson(actionListChats(config, { query: flag(argv, "--query") }));
        return;
      case "thread": {
        const limit = flag(argv, "--limit");
        const before = flag(argv, "--before");
        const chatId = flag(argv, "--chat-id");
        const handle = flag(argv, "--handle");
        printJson(
          actionGetThread(config, {
            chat_id: chatId ? Number(chatId) : undefined,
            handle,
            limit: limit ? Number(limit) : undefined,
            before: before && /^-?\d+$/.test(before) ? Number(before) : before,
            from_date: flag(argv, "--from"),
            to_date: flag(argv, "--to"),
          }),
        );
        return;
      }
      case "search": {
        const query = argv.slice(1).filter((a) => !a.startsWith("--"))[0];
        if (!query) throw new MessagesError("INVALID_ARGS", "search requires a query.");
        printJson(actionSearch(config, { query }));
        return;
      }
      case "send": {
        const to = flag(argv, "--to");
        const body = flag(argv, "--body");
        if (!to || !body) {
          throw new MessagesError("INVALID_ARGS", "send requires --to and --body.");
        }
        printJson(
          await actionSend(config, {
            to,
            body,
            confirm: argv.includes("--confirm"),
            dry_run: argv.includes("--dry-run"),
          }),
        );
        return;
      }
      case "watch": {
        const interval = Number(flag(argv, "--interval") ?? process.env.MESSAGES_WATCH_INTERVAL_MS ?? 3000);
        const includePreview =
          process.env.WATCH_INCLUDE_PREVIEW === "1" || argv.includes("--preview");
        const controller = new AbortController();
        process.on("SIGINT", () => controller.abort());
        process.on("SIGTERM", () => controller.abort());
        await runWatcher({
          config,
          intervalMs: Number.isFinite(interval) ? Math.max(500, interval) : 3000,
          includePreview,
          useFsWatch: process.env.MESSAGES_WATCH_FS !== "0",
          wakeHook: process.env.MESSAGES_WAKE_HOOK?.trim() || null,
          signal: controller.signal,
        });
        return;
      }
      default: {
        const exhaustive: never = command;
        throw new MessagesError("INVALID_ARGS", `Unknown command: ${String(exhaustive)}`);
      }
    }
  } catch (err) {
    fail(err);
  }
}

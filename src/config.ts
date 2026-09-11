import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, DbMode } from "./types.ts";

export const UNSCOPED_NOTE =
  "MESSAGES_ALLOW_UNSCOPED=1 is set. All readable chats are available to the agent. Unset it and set MESSAGES_SCOPE to restrict the allowlist.";

export const SCOPED_SHUT_NOTE =
  "No MESSAGES_SCOPE is set and MESSAGES_ALLOW_UNSCOPED is unset. list, search, get_thread, send, and watch return SCOPE. Set MESSAGES_SCOPE to display names, chat_id, guid, or handles; or set MESSAGES_ALLOW_UNSCOPED=1 to open the whole inbox.";

export const ALLOWLIST_NOTE =
  "Restricted to the configured chat allowlist. Other threads are hidden from list/thread/search/send/watch.";

export function defaultChatDbPath(): string {
  return join(homedir(), "Library", "Messages", "chat.db");
}

export function envFlag(
  name: string,
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Scoped shut unless the host explicitly opens the inbox. */
export function isScopeActive(config: Config): boolean {
  return !config.allowUnscoped;
}

function envDbMode(env: NodeJS.ProcessEnv): DbMode {
  const raw = env.MESSAGES_DB_MODE?.trim().toLowerCase();
  if (raw === "direct") return "direct";
  return "copy";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dbPath: env.MESSAGES_DB_PATH?.trim() || defaultChatDbPath(),
    dbMode: envDbMode(env),
    enableSend: envFlag("ENABLE_SEND", false, env),
    redactPreviews: envFlag("REDACT_PREVIEWS", false, env),
    scope: parseAllowlist(env.MESSAGES_SCOPE),
    allowUnscoped: envFlag("MESSAGES_ALLOW_UNSCOPED", false, env),
  };
}

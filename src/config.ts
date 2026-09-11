import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, DbMode } from "./types.ts";

export const UNSCOPED_NOTE =
  "No MESSAGES_SCOPE_DISPLAY_NAME, MESSAGES_SCOPE_CHAT_ID, or MESSAGES_SCOPE_ALLOWLIST is set. All readable chats are available to the agent. Set one of those env vars to restrict the allowlist.";

export const ALLOWLIST_NOTE =
  "Restricted to the configured chat allowlist. Other threads are hidden from list/thread/search/send.";

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

export function isScopeActive(config: Config): boolean {
  if (config.allowUnscoped) return false;
  return (
    config.scopeDisplayName !== null ||
    config.scopeChatId !== null ||
    config.scopeAllowlist.length > 0
  );
}

function envDbMode(env: NodeJS.ProcessEnv): DbMode {
  const raw = env.MESSAGES_DB_MODE?.trim().toLowerCase();
  if (raw === "direct") return "direct";
  return "copy";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const scopeName = env.MESSAGES_SCOPE_DISPLAY_NAME?.trim();
  const scopeChatId = env.MESSAGES_SCOPE_CHAT_ID?.trim();
  const parsedId = scopeChatId ? Number(scopeChatId) : null;

  return {
    dbPath: env.MESSAGES_DB_PATH?.trim() || defaultChatDbPath(),
    dbMode: envDbMode(env),
    enableSend: envFlag("ENABLE_SEND", false, env),
    redactPreviews: envFlag("REDACT_PREVIEWS", false, env),
    scopeDisplayName: scopeName ? scopeName : null,
    scopeChatId:
      parsedId !== null && Number.isInteger(parsedId) && parsedId > 0
        ? parsedId
        : null,
    scopeAllowlist: parseAllowlist(env.MESSAGES_SCOPE_ALLOWLIST),
    allowUnscoped: envFlag("MESSAGES_ALLOW_UNSCOPED", false, env),
  };
}

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Config, StatusReport } from "./types.ts";
import { MessagesError } from "./types.ts";
import { isScopeActive } from "./config.ts";
import { listTables, openChatDb, tableColumns } from "./db/open.ts";
import { emptyScope, resolveScope } from "./db/queries.ts";

function readMacos(): StatusReport["macos"] {
  if (process.platform !== "darwin") return null;
  try {
    const product = execFileSync("sw_vers", ["-productName"], {
      encoding: "utf8",
    }).trim();
    const version = execFileSync("sw_vers", ["-productVersion"], {
      encoding: "utf8",
    }).trim();
    const build = execFileSync("sw_vers", ["-buildVersion"], {
      encoding: "utf8",
    }).trim();
    return { product, version, build };
  } catch {
    return { product: "macOS", version: "unknown", build: "unknown" };
  }
}

export function getStatus(config: Config): StatusReport {
  const base: StatusReport = {
    ok: false,
    readable: false,
    db_path: config.dbPath,
    db_exists: existsSync(config.dbPath),
    db_mode: config.dbMode,
    opened_via: null,
    fda_likely_missing: false,
    error: null,
    platform: process.platform,
    macos: readMacos(),
    send_enabled: config.enableSend,
    redact_previews: config.redactPreviews,
    allow_unscoped: config.allowUnscoped,
    unscoped: !isScopeActive(config),
    scope: emptyScope(config),
    schema: null,
  };

  if (process.platform !== "darwin" && !process.env.MESSAGES_DB_PATH) {
    base.error = {
      code: "UNSUPPORTED",
      message:
        "This connector reads ~/Library/Messages/chat.db on macOS. On this host, set MESSAGES_DB_PATH to a fixture database.",
    };
  }

  try {
    const opened = openChatDb(config.dbPath, config.dbMode);
    try {
      const tables = listTables(opened.db);
      const messageCols = tables.includes("message")
        ? tableColumns(opened.db, "message")
        : new Set<string>();
      base.opened_via = opened.mode;
      base.readable = true;
      base.schema = {
        tables,
        has_attributed_body: messageCols.has("attributedBody"),
        has_chat_message_join: tables.includes("chat_message_join"),
      };
      base.scope = resolveScope(opened.db, config);
      base.ok = true;
      base.error = null;
      return base;
    } finally {
      opened.cleanup();
    }
  } catch (err) {
    if (err instanceof MessagesError) {
      base.error = { code: err.code, message: err.message };
      base.fda_likely_missing = err.code === "PERMISSION";
      return base;
    }
    const message = err instanceof Error ? err.message : String(err);
    base.error = { code: "OPEN_FAILED", message };
    return base;
  }
}

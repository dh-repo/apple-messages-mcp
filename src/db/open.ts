import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DbMode } from "../types.ts";
import { MessagesError } from "../types.ts";

export type OpenedDb = {
  db: DatabaseSync;
  sourcePath: string;
  openedPath: string;
  mode: DbMode;
  cleanup: () => void;
};

function classifyAccessError(err: unknown, path: string): MessagesError {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (code === "ENOENT") {
    return new MessagesError(
      "NOT_FOUND",
      `chat.db not found at ${path}. Messages.app may never have been used on this Mac, or MESSAGES_DB_PATH is wrong.`,
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new MessagesError(
      "PERMISSION",
      `Cannot read ${path}. Grant Full Disk Access to the process that launches this MCP server (Cursor, Terminal, or node), then restart that app.`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new MessagesError("OPEN_FAILED", `Failed to open ${path}: ${message}`);
}

function copySidecar(sourceDb: string, destDb: string, suffix: string): void {
  const from = `${sourceDb}${suffix}`;
  if (!existsSync(from)) return;
  copyFileSync(from, `${destDb}${suffix}`);
}

/**
 * Open chat.db.
 *
 * Default `copy` mode copies chat.db plus WAL/SHM sidecars to a 0700 temp
 * directory and opens the copy read-write so SQLite can apply the WAL.
 * Messages.app keeps a lock on the live file; querying it directly often
 * fails or returns a stale snapshot. The copy is deleted when cleanup() runs.
 */
export function openChatDb(sourcePath: string, mode: DbMode): OpenedDb {
  try {
    accessSync(sourcePath, constants.R_OK);
  } catch (err) {
    throw classifyAccessError(err, sourcePath);
  }

  if (mode === "direct") {
    try {
      const db = new DatabaseSync(sourcePath, { readOnly: true });
      db.exec("PRAGMA query_only = ON");
      return {
        db,
        sourcePath,
        openedPath: sourcePath,
        mode: "direct",
        cleanup: () => {
          try {
            db.close();
          } catch {
            /* ignore */
          }
        },
      };
    } catch (err) {
      throw classifyAccessError(err, sourcePath);
    }
  }

  const dir = join(
    tmpdir(),
    `apple-messages-mcp-${process.pid}-${Date.now().toString(36)}`,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, basename(sourcePath) || "chat.db");

  try {
    copyFileSync(sourcePath, dest);
    copySidecar(sourcePath, dest, "-wal");
    copySidecar(sourcePath, dest, "-shm");
    const db = new DatabaseSync(dest);
    db.exec("PRAGMA query_only = ON");
    return {
      db,
      sourcePath,
      openedPath: dest,
      mode: "copy",
      cleanup: () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw classifyAccessError(err, sourcePath);
  }
}

export function withChatDb<T>(
  sourcePath: string,
  mode: DbMode,
  fn: (db: DatabaseSync) => T,
): T {
  const opened = openChatDb(sourcePath, mode);
  try {
    return fn(opened.db);
  } finally {
    opened.cleanup();
  }
}

export function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

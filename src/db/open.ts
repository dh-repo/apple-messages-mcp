import * as fs from "node:fs";
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

export type SnapshotInfo = {
  temp_copy_bytes: number | null;
  snapshot_age_ms: number | null;
};

type Snapshot = {
  sourcePath: string;
  dir: string;
  dest: string;
  db: DatabaseSync | null;
  sourceSig: string;
  copiedAtMs: number;
  tempCopyBytes: number;
};

const COPY_RETRIES = 3;

let snapshot: Snapshot | null = null;
let exitHooked = false;
let copyFileSyncImpl: typeof fs.copyFileSync = fs.copyFileSync;

/** Test hook: count real snapshot recopies (not per-sidecar). */
export let snapshotCopyRuns = 0;

export function setCopyFileSyncForTests(fn: typeof fs.copyFileSync | null): void {
  copyFileSyncImpl = fn ?? fs.copyFileSync;
}

export function resetChatDbSnapshot(): void {
  snapshotCopyRuns = 0;
  if (snapshot) {
    closeSnapshotDb(snapshot);
    try {
      fs.rmSync(snapshot.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    snapshot = null;
  }
}

export function getSnapshotInfo(sourcePath: string): SnapshotInfo {
  if (!snapshot || snapshot.sourcePath !== sourcePath) {
    return { temp_copy_bytes: null, snapshot_age_ms: null };
  }
  return {
    temp_copy_bytes: snapshot.tempCopyBytes,
    snapshot_age_ms: Date.now() - snapshot.copiedAtMs,
  };
}

function closeSnapshotDb(current: Snapshot): void {
  if (!current.db) return;
  try {
    current.db.close();
  } catch {
    /* ignore */
  }
  current.db = null;
}

function hookExitOnce(): void {
  if (exitHooked) return;
  exitHooked = true;
  const unlink = (): void => {
    resetChatDbSnapshot();
  };
  process.once("exit", unlink);
  process.once("SIGTERM", () => {
    unlink();
  });
}

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

function statSig(path: string): string {
  try {
    const st = fs.statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function liveSignature(sourcePath: string): string {
  return `${statSig(sourcePath)}|${statSig(`${sourcePath}-wal`)}`;
}

function copySidecar(sourceDb: string, destDb: string, suffix: string): void {
  const from = `${sourceDb}${suffix}`;
  if (!fs.existsSync(from)) return;
  copyFileSyncImpl(from, `${destDb}${suffix}`);
}

function directoryBytes(dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    total += fs.statSync(join(dir, name)).size;
  }
  return total;
}

/**
 * Best-effort consistent copy while imagent may be writing.
 * Order: wal, db, wal again, shm. Then PRAGMA integrity_check. Retry N.
 * This is still a race, not a snapshot isolation guarantee.
 */
function copyLiveDb(sourcePath: string, dest: string): void {
  copySidecar(sourcePath, dest, "-wal");
  copyFileSyncImpl(sourcePath, dest);
  copySidecar(sourcePath, dest, "-wal");
  copySidecar(sourcePath, dest, "-shm");
}

function integrityOk(path: string): boolean {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    return (row?.integrity_check ?? "").toLowerCase() === "ok";
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function ensureSnapshot(sourcePath: string): Snapshot {
  hookExitOnce();
  const sig = liveSignature(sourcePath);
  if (snapshot && snapshot.sourcePath === sourcePath && snapshot.sourceSig === sig && fs.existsSync(snapshot.dest)) {
    return snapshot;
  }

  if (snapshot && snapshot.sourcePath !== sourcePath) {
    resetChatDbSnapshot();
  }

  const dir =
    snapshot?.dir ??
    join(tmpdir(), `apple-messages-mcp-${process.pid}-${Date.now().toString(36)}`);
  if (!snapshot) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const dest = snapshot?.dest ?? join(dir, basename(sourcePath) || "chat.db");

  if (snapshot) {
    closeSnapshotDb(snapshot);
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= COPY_RETRIES; attempt += 1) {
    try {
      copyLiveDb(sourcePath, dest);
      snapshotCopyRuns += 1;
      if (!integrityOk(dest)) {
        lastErr = new Error(`PRAGMA integrity_check failed (attempt ${attempt})`);
        continue;
      }
      const next: Snapshot = {
        sourcePath,
        dir,
        dest,
        db: null,
        sourceSig: liveSignature(sourcePath),
        copiedAtMs: Date.now(),
        tempCopyBytes: directoryBytes(dir),
      };
      snapshot = next;
      return next;
    } catch (err) {
      lastErr = err;
    }
  }
  throw classifyAccessError(lastErr, sourcePath);
}

function openSnapshotConnection(current: Snapshot): DatabaseSync {
  if (current.db) return current.db;
  const db = new DatabaseSync(current.dest);
  db.exec("PRAGMA query_only = ON");
  current.db = db;
  return db;
}

/**
 * Open chat.db.
 *
 * Default `copy` mode keeps one 0700 snapshot per process. Recopy only when
 * live `chat.db` or `-wal` mtime/size changes. Open the copy so SQLite can
 * apply the WAL, then `PRAGMA query_only=ON`. Unlink on process exit / SIGTERM.
 * Copy while Messages.app is writing is best-effort (wal, db, wal, integrity_check, retry).
 */
export function openChatDb(sourcePath: string, mode: DbMode): OpenedDb {
  try {
    fs.accessSync(sourcePath, fs.constants.R_OK);
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

  try {
    const current = ensureSnapshot(sourcePath);
    const db = openSnapshotConnection(current);
    return {
      db,
      sourcePath,
      openedPath: current.dest,
      mode: "copy",
      cleanup: () => {
        /* Process snapshot stays warm. Watcher and tool calls share it. */
      },
    };
  } catch (err) {
    if (err instanceof MessagesError) throw err;
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

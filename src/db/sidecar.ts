import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Process-owned decode cache. Not Apple's chat.db.
 * Schema is only (message_id, decoded_text) plus a MAX(ROWID) stamp.
 * No FTS. Never write these rows back into chat.db.
 */
export type DecodeSidecar = {
  readonly path: string;
  get(messageId: number): string | undefined;
  put(messageId: number, decodedText: string): void;
  search(needle: string): Array<{ message_id: number; decoded_text: string }>;
  messageIds(): number[];
  storedMaxRowid(): number | null;
  setStoredMaxRowid(value: number): void;
  clear(): void;
  close(): void;
};

const META_MAX = "max_rowid";

let sidecarRoot: string | null = null;
const openSidecars = new Map<string, DecodeSidecar>();
let exitHooked = false;

function hookExitOnce(): void {
  if (exitHooked) return;
  exitHooked = true;
  const unlink = (): void => {
    resetDecodeSidecars();
  };
  process.once("exit", unlink);
  process.once("SIGTERM", () => {
    unlink();
  });
}

function ensureRoot(): string {
  hookExitOnce();
  if (sidecarRoot && sidecarRoot.length > 0) return sidecarRoot;
  sidecarRoot = join(tmpdir(), `apple-messages-mcp-sidecar-${process.pid}`);
  mkdirSync(sidecarRoot, { recursive: true, mode: 0o700 });
  return sidecarRoot;
}

export function sidecarPathForSource(sourcePath: string): string {
  const hash = createHash("sha256").update(sourcePath).digest("hex").slice(0, 16);
  return join(ensureRoot(), `${hash}.sqlite`);
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function openDecodeSidecar(filePath: string): DecodeSidecar {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS decoded (
      message_id INTEGER PRIMARY KEY,
      decoded_text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const getStmt = db.prepare(`SELECT decoded_text FROM decoded WHERE message_id = ?`);
  const putStmt = db.prepare(
    `INSERT INTO decoded (message_id, decoded_text) VALUES (?, ?)
     ON CONFLICT(message_id) DO UPDATE SET decoded_text = excluded.decoded_text`,
  );
  const searchStmt = db.prepare(
    `SELECT message_id, decoded_text FROM decoded
     WHERE decoded_text != '' AND LOWER(decoded_text) LIKE ?`,
  );
  const idsStmt = db.prepare(`SELECT message_id FROM decoded`);
  const metaGet = db.prepare(`SELECT value FROM meta WHERE key = ?`);
  const metaPut = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error(`Decode sidecar is closed: ${filePath}`);
  };

  return {
    path: filePath,
    get(messageId: number): string | undefined {
      assertOpen();
      const row = getStmt.get(messageId) as { decoded_text?: unknown } | undefined;
      const text = asText(row?.decoded_text);
      return text === null ? undefined : text;
    },
    put(messageId: number, decodedText: string): void {
      assertOpen();
      putStmt.run(messageId, decodedText);
    },
    search(needle: string): Array<{ message_id: number; decoded_text: string }> {
      assertOpen();
      const like = `%${needle.toLowerCase()}%`;
      const rows = searchStmt.all(like) as Array<Record<string, unknown>>;
      return rows
        .map((row) => ({
          message_id: asNumber(row.message_id) ?? 0,
          decoded_text: asText(row.decoded_text) ?? "",
        }))
        .filter((row) => row.message_id > 0);
    },
    messageIds(): number[] {
      assertOpen();
      const rows = idsStmt.all() as Array<Record<string, unknown>>;
      return rows
        .map((row) => asNumber(row.message_id))
        .filter((id): id is number => id !== null && id > 0);
    },
    storedMaxRowid(): number | null {
      assertOpen();
      const row = metaGet.get(META_MAX) as { value?: unknown } | undefined;
      return asNumber(row?.value);
    },
    setStoredMaxRowid(value: number): void {
      assertOpen();
      metaPut.run(META_MAX, String(value));
    },
    clear(): void {
      assertOpen();
      db.exec(`DELETE FROM decoded; DELETE FROM meta;`);
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export function getProcessSidecar(sourcePath: string): DecodeSidecar {
  const existing = openSidecars.get(sourcePath);
  if (existing) return existing;
  const created = openDecodeSidecar(sidecarPathForSource(sourcePath));
  openSidecars.set(sourcePath, created);
  return created;
}

export function resetDecodeSidecars(): void {
  for (const sidecar of openSidecars.values()) {
    sidecar.close();
  }
  openSidecars.clear();
  if (sidecarRoot) {
    try {
      rmSync(sidecarRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    sidecarRoot = null;
  }
}

export function liveMaxRowid(db: DatabaseSync): number {
  const row = db.prepare(`SELECT MAX(ROWID) AS max_rowid FROM message`).get() as
    | { max_rowid?: unknown }
    | undefined;
  return asNumber(row?.max_rowid) ?? 0;
}

/**
 * Sidecar is valid for a single live MAX(ROWID).
 * Rising MAX: keep decoded rows (old Tahoe blobs stay searchable) but
 * the stamp is stale until the next decode-scan ingests new ROWIDs.
 * Falling MAX (restore / rebuild): wipe — those ids are not this database.
 */
export function syncSidecarWithLiveMax(
  db: DatabaseSync,
  sidecar: DecodeSidecar,
): { liveMax: number; maxMoved: boolean; wiped: boolean } {
  const liveMax = liveMaxRowid(db);
  const stored = sidecar.storedMaxRowid();
  let wiped = false;
  if (stored !== null && liveMax < stored) {
    sidecar.clear();
    wiped = true;
  }
  const maxMoved = stored !== liveMax;
  if (maxMoved) {
    sidecar.setStoredMaxRowid(liveMax);
  }
  return { liveMax, maxMoved, wiped };
}

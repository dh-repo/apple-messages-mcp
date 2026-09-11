import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const WAL_ONLY_TEXT = "newest-row-lives-in-wal";
export const WAL_ONLY_GUID = "wal-only-guid";

export type WalOnlyFixture = {
  path: string;
  walOnlyText: string;
  walOnlyGuid: string;
  writer: DatabaseSync;
  cleanup: () => void;
};

/**
 * Newest message exists only in -wal. Caller must copy while `writer` is open;
 * closing the writer checkpoints and the row moves into the main file.
 */
export function createWalOnlyRowFixture(): WalOnlyFixture {
  const root = mkdtempSync(join(tmpdir(), "apple-messages-wal-"));
  mkdirSync(root, { recursive: true });
  const path = join(root, "chat.db");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      text TEXT,
      date INTEGER
    );
  `);
  writer.prepare(`INSERT INTO message (guid, text, date) VALUES (?, ?, ?)`).run(
    "checkpointed-guid",
    "checkpointed-row",
    1,
  );
  writer.exec("PRAGMA wal_checkpoint(FULL)");
  writer
    .prepare(`INSERT INTO message (guid, text, date) VALUES (?, ?, ?)`)
    .run(WAL_ONLY_GUID, WAL_ONLY_TEXT, 2);

  if (!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size <= 0) {
    writer.close();
    rmSync(root, { recursive: true, force: true });
    throw new Error("WAL fixture: expected a non-empty -wal after the newest insert");
  }

  return {
    path,
    walOnlyText: WAL_ONLY_TEXT,
    walOnlyGuid: WAL_ONLY_GUID,
    writer,
    cleanup: () => {
      try {
        writer.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

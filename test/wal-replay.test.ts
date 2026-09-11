import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openChatDb, resetChatDbSnapshot } from "../src/db/open.ts";
import { createWalOnlyRowFixture, WAL_ONLY_TEXT } from "./helpers/wal.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  resetChatDbSnapshot();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("real WAL replay", () => {
  it("makes a newest row that exists only in -wal visible after copy+apply", () => {
    const fixture = createWalOnlyRowFixture();
    cleanups.push(fixture.cleanup);

    const scratch = mkdtempSync(join(tmpdir(), "apple-messages-wal-copy-"));
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));

    const dbOnly = join(scratch, "db-only.db");
    copyFileSync(fixture.path, dbOnly);
    const withoutWal = new DatabaseSync(dbOnly);
    const missing = withoutWal
      .prepare(`SELECT text FROM message WHERE text = ?`)
      .get(WAL_ONLY_TEXT);
    expect(missing).toBeUndefined();
    expect(
      (withoutWal.prepare(`SELECT text FROM message ORDER BY ROWID`).all() as Array<{ text: string }>)
        .map((row) => row.text),
    ).toEqual(["checkpointed-row"]);
    withoutWal.close();

    const opened = openChatDb(fixture.path, "copy");
    cleanups.push(opened.cleanup);
    const texts = (
      opened.db.prepare(`SELECT text FROM message ORDER BY ROWID`).all() as Array<{ text: string }>
    ).map((row) => row.text);
    expect(texts).toContain("checkpointed-row");
    expect(texts).toContain(WAL_ONLY_TEXT);
    const newest = opened.db
      .prepare(`SELECT text FROM message WHERE guid = ?`)
      .get(fixture.walOnlyGuid) as { text: string } | undefined;
    expect(newest?.text).toBe(WAL_ONLY_TEXT);
  });
});

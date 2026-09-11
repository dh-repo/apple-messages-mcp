import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { actionSearch } from "../src/actions.ts";
import { encodeAttributedBody } from "../src/decode/attributedBody.ts";
import { isoToAppleNanos } from "../src/db/dates.ts";
import { listTables } from "../src/db/open.ts";
import { searchMessages } from "../src/db/queries.ts";
import {
  liveMaxRowid,
  openDecodeSidecar,
  syncSidecarWithLiveMax,
} from "../src/db/sidecar.ts";
import {
  createFixtureDb,
  createSearchWindowFixture,
  makeUnscopedConfig,
  TAHOE_WINDOW,
} from "./helpers/fixture.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function addTahoeRow(path: string, chatId: number, guid: string, text: string, iso: string): number {
  const db = new DatabaseSync(path);
  const date = isoToAppleNanos(iso).toString();
  const id = Number(
    db
      .prepare(
        `INSERT INTO message (guid, text, attributedBody, handle_id, date, is_from_me, service, associated_message_type, item_type)
         VALUES (?, NULL, ?, 1, ?, 0, 'iMessage', 0, 0)`,
      )
      .run(guid, encodeAttributedBody(text), date).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  ).run(chatId, id, date);
  db.close();
  return id;
}

function appleMaster(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  const names = listTables(db);
  db.close();
  return names;
}

describe("decode sidecar", () => {
  it("is our file of (message_id, decoded_text) and invalidates on MAX(ROWID)", () => {
    const dir = mkdtempSync(join(tmpdir(), "apple-messages-sidecar-"));
    const sidecar = openDecodeSidecar(join(dir, "decode.sqlite"));
    cleanups.push(() => sidecar.close());

    sidecar.put(3, "meet at 7");
    sidecar.setStoredMaxRowid(3);
    expect(sidecar.get(3)).toBe("meet at 7");
    expect(sidecar.search("meet at").map((row) => row.message_id)).toEqual([3]);
    expect(sidecar.storedMaxRowid()).toBe(3);
    const catalog = new DatabaseSync(sidecar.path, { readOnly: true });
    const tables = catalog
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    catalog.close();
    expect(tables.map((row) => row.name)).toEqual(["decoded", "meta"]);
    expect(tables.some((row) => row.name.toLowerCase().includes("fts"))).toBe(false);

    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    const live = liveMaxRowid(db);
    expect(live).toBeGreaterThan(0);

    const rose = syncSidecarWithLiveMax(db, sidecar);
    expect(rose.maxMoved).toBe(true);
    expect(rose.wiped).toBe(live < 3);
    if (live >= 3) {
      expect(sidecar.get(3)).toBe("meet at 7");
    }
    expect(sidecar.storedMaxRowid()).toBe(live);

    sidecar.put(99, "should vanish on falling MAX");
    sidecar.setStoredMaxRowid(live + 50);
    const fell = syncSidecarWithLiveMax(db, sidecar);
    expect(fell.wiped).toBe(true);
    expect(fell.maxMoved).toBe(true);
    expect(sidecar.get(99)).toBeUndefined();
    expect(sidecar.storedMaxRowid()).toBe(live);
    db.close();
  });

  it("keeps a Tahoe blob searchable after it leaves the scan window", () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const keepText = "keep-me-visible-after-window";
    addTahoeRow(fixture.path, fixture.ids.groupChatId, "keep-me", keepText, "2026-08-15T12:00:00Z");

    const config = makeUnscopedConfig({ dbPath: fixture.path });
    const first = actionSearch(config, { query: "keep-me-visible" });
    expect(first.messages.some((row) => row.text.includes(keepText))).toBe(true);

    for (let i = 0; i < TAHOE_WINDOW + 1; i += 1) {
      const minute = i % 60;
      const hour = 10 + Math.floor(i / 60);
      addTahoeRow(
        fixture.path,
        fixture.ids.groupChatId,
        `noise-${i}`,
        `recent noise ${i}`,
        `2026-09-01T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
      );
    }

    const db = new DatabaseSync(fixture.path, { readOnly: true });
    const withoutSidecar = searchMessages(db, {
      query: "keep-me-visible",
      limit: 10,
      redact: false,
    });
    expect(withoutSidecar.messages).toEqual([]);
    expect(withoutSidecar.truncated).toBe(true);

    const second = actionSearch(config, { query: "keep-me-visible", limit: 10 });
    expect(second.messages.some((row) => row.text.includes(keepText))).toBe(true);
    expect(second.truncated).toBe(true);
    db.close();
  });

  it("still admits truncated for a never-decoded Tahoe row and does not write chat.db", () => {
    const fixture = createSearchWindowFixture();
    cleanups.push(fixture.cleanup);
    const beforeBytes = readFileSync(fixture.path);
    const beforeTables = appleMaster(fixture.path);

    const missed = actionSearch(makeUnscopedConfig({ dbPath: fixture.path }), {
      query: "ancient secret",
      limit: 10,
    });
    expect(missed.messages).toEqual([]);
    expect(missed.truncated).toBe(true);
    expect(missed.scanned).toBeGreaterThan(0);

    expect(readFileSync(fixture.path).equals(beforeBytes)).toBe(true);
    expect(appleMaster(fixture.path)).toEqual(beforeTables);
    expect(beforeTables.some((name) => name.toLowerCase().includes("fts"))).toBe(false);
  });
});

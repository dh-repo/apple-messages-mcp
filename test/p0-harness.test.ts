import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { isoToAppleNanos } from "../src/db/dates.ts";
import { listChats, resolveScope, searchMessages } from "../src/db/queries.ts";
import { emptyWatcherState, pollOnce } from "../src/watch/poll.ts";
import {
  createFixtureDb,
  createResolveDepthFixture,
  createSearchWindowFixture,
  GROUP_NAME,
  makeScopedConfig,
  makeUnscopedConfig,
  OLDEST_HANDLE,
} from "./helpers/fixture.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function insertMessage(path: string, chatId: number, text: string, iso: string): number {
  const db = new DatabaseSync(path);
  const date = isoToAppleNanos(iso).toString();
  const id = Number(
    db
      .prepare(
        `INSERT INTO message (guid, text, handle_id, date, is_from_me, service, associated_message_type, item_type)
         VALUES (?, ?, 1, ?, 0, 'iMessage', 0, 0)`,
      )
      .run(`msg-${Date.now()}-${Math.random()}`, text, date).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  ).run(chatId, id, date);
  db.close();
  return id;
}

describe("P0.2 watcher per-chat watermark", () => {
  it("emits two messages.new with two chat_ids when two chats move in one tick", () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const config = makeUnscopedConfig({ dbPath: fixture.path });

    const ready = pollOnce(config, emptyWatcherState(), { includePreview: false });
    expect(ready.events[0]?.type).toBe("messages.ready");

    insertMessage(fixture.path, fixture.ids.groupChatId, "group moved", "2026-09-01T12:00:00Z");
    insertMessage(fixture.path, fixture.ids.decoyChatId, "decoy moved", "2026-09-01T12:00:01Z");

    const tick = pollOnce(config, ready.state, { includePreview: false });
    const news = tick.events.filter((event) => event.type === "messages.new");
    expect(news).toHaveLength(2);
    expect(new Set(news.map((event) => event.chat_id))).toEqual(
      new Set([fixture.ids.groupChatId, fixture.ids.decoyChatId]),
    );
    for (const event of news) {
      if (event.type === "messages.new") {
        expect(event.preview).toBeNull();
        expect(event.guid).toBeTruthy();
      }
    }
  });
});

describe("P0.3 resolve without the hottest 100", () => {
  it("scopes the oldest of 101 chats by ROWID and by handle; query=weekend honors limit", () => {
    const fixture = createResolveDepthFixture();
    cleanups.push(fixture.cleanup);
    const db = new DatabaseSync(fixture.path, { readOnly: true });

    const byRow = resolveScope(
      db,
      makeScopedConfig({ dbPath: fixture.path, scope: [String(fixture.oldestChatId)] }),
    );
    expect(byRow.matched).toBe(true);
    expect(byRow.chats.map((chat) => chat.chat_id)).toContain(fixture.oldestChatId);

    const byHandle = resolveScope(
      db,
      makeScopedConfig({ dbPath: fixture.path, scope: [OLDEST_HANDLE] }),
    );
    expect(byHandle.matched).toBe(true);
    expect(byHandle.chats.map((chat) => chat.chat_id)).toContain(fixture.oldestChatId);

    const hits = listChats(db, { query: "weekend", limit: 5, redact: false });
    expect(hits.some((chat) => chat.display_name === GROUP_NAME)).toBe(true);
    expect(hits[0]?.chat_id).toBe(fixture.oldestChatId);
    db.close();
  });
});

describe("P0.4 two-phase search", () => {
  it("hits old plain-text, recent Tahoe-only, and admits a window miss", () => {
    const fixture = createSearchWindowFixture();
    cleanups.push(fixture.cleanup);
    const db = new DatabaseSync(fixture.path, { readOnly: true });

    const oldPlain = searchMessages(db, { query: "Dentist 2019", redact: false });
    expect(oldPlain.messages.some((row) => row.text.includes("Dentist 2019"))).toBe(true);

    const recentTahoe = searchMessages(db, { query: "clinic tonight", redact: false });
    expect(recentTahoe.messages.some((row) => row.text.includes("clinic tonight"))).toBe(
      true,
    );

    const missed = searchMessages(db, {
      query: "ancient secret",
      limit: 10,
      redact: false,
    });
    expect(missed.messages).toEqual([]);
    expect(missed.truncated).toBe(true);
    expect(missed.scanned).toBeGreaterThan(0);
    db.close();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { isoToAppleNanos } from "../src/db/dates.ts";
import {
  emptyWatcherState,
  pollOnce,
} from "../src/watch/poll.ts";
import { createFixtureDb, GROUP_NAME, makeConfig, makeScopedConfig } from "./helpers/fixture.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function insertGroupMessage(path: string, chatId: number, text: string, iso: string): number {
  const db = new DatabaseSync(path);
  const date = isoToAppleNanos(iso).toString();
  const id = Number(
    db
      .prepare(
        `INSERT INTO message (guid, text, handle_id, date, is_from_me, service, associated_message_type, item_type)
         VALUES (?, ?, 1, ?, 0, 'iMessage', 0, 0)`,
      )
      .run(`msg-${Date.now()}`, text, date).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  ).run(chatId, id, date);
  db.close();
  return id;
}

describe("watcher poll", () => {
  it("emits ready then new without putting plaintext in the wake event", () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const config = makeScopedConfig({ dbPath: fixture.path });

    const first = pollOnce(config, emptyWatcherState(), { includePreview: true });
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      type: "messages.ready",
      chat_id: fixture.ids.groupChatId,
      display_name: GROUP_NAME,
    });

    const idle = pollOnce(config, first.state, { includePreview: true });
    expect(idle.events).toEqual([]);

    insertGroupMessage(
      fixture.path,
      fixture.ids.groupChatId,
      "new snacks run",
      "2026-03-03T12:00:00Z",
    );

    const second = pollOnce(config, first.state, { includePreview: true });
    expect(second.events).toHaveLength(1);
    const event = second.events[0];
    expect(event?.type).toBe("messages.new");
    if (event?.type === "messages.new") {
      expect(event.count_new).toBe(1);
      expect(event.newest_message_id).toBeGreaterThan(event.previous_message_id ?? 0);
      expect(event.preview).toMatch(/^\[redacted \d+ chars\]$/);
      expect(JSON.stringify(event)).not.toContain("snacks");
    }
  });

  it("does not wake for a decoy-thread insert while scoped", () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const config = makeScopedConfig({ dbPath: fixture.path });
    const first = pollOnce(config, emptyWatcherState(), { includePreview: false });

    insertGroupMessage(
      fixture.path,
      fixture.ids.decoyChatId,
      "SECRET decoy follow-up",
      "2026-03-03T13:00:00Z",
    );

    const second = pollOnce(config, first.state, { includePreview: false });
    expect(second.events).toEqual([]);
  });
});

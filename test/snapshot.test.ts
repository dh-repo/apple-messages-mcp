import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, writeFileSync } from "node:fs";
import { emptyWatcherState, pollOnce } from "../src/watch/poll.ts";
import { resetChatDbSnapshot, setCopyFileSyncForTests } from "../src/db/open.ts";
import { createFixtureDb, makeUnscopedConfig } from "./helpers/fixture.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  setCopyFileSyncForTests(null);
  resetChatDbSnapshot();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("warm snapshot", () => {
  it("does not recopy when wal/db mtime is unchanged; recopies when wal grows", () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    let copies = 0;
    setCopyFileSyncForTests((source, dest, mode) => {
      copies += 1;
      return copyFileSync(source, dest, mode);
    });

    const config = makeUnscopedConfig({ dbPath: fixture.path, dbMode: "copy" });
    const first = pollOnce(config, emptyWatcherState(), { includePreview: false });
    expect(first.events[0]?.type).toBe("messages.ready");
    expect(copies).toBeGreaterThan(0);

    const afterReady = copies;
    const second = pollOnce(config, first.state, { includePreview: false });
    expect(second.events).toEqual([]);
    expect(copies).toBe(afterReady);

    writeFileSync(`${fixture.path}-wal`, "wal-grew");
    pollOnce(config, second.state, { includePreview: false });
    expect(copies).toBeGreaterThan(afterReady);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStatus } from "../src/status.ts";
import {
  createFixtureDb,
  GROUP_NAME,
  makeConfig,
  makeScopedConfig,
  makeUnscopedConfig,
} from "./helpers/fixture.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("messages_status", () => {
  it("reports a readable fixture as scoped shut by default", () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const status = getStatus(makeConfig({ dbPath: fixture.path }));
    expect(status.readable).toBe(true);
    expect(status.ok).toBe(true);
    expect(status.fda_likely_missing).toBe(false);
    expect(status.unscoped).toBe(false);
    expect(status.allow_unscoped).toBe(false);
    expect(status.scope.active).toBe(true);
    expect(status.scope.matched).toBe(false);
    expect(status.scope.note).toMatch(/return SCOPE/);
    expect(status.schema?.has_attributed_body).toBe(true);
    expect(status.send_enabled).toBe(false);
  });

  it("reports unscoped only with the explicit flag", () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const status = getStatus(makeUnscopedConfig({ dbPath: fixture.path }));
    expect(status.unscoped).toBe(true);
    expect(status.allow_unscoped).toBe(true);
    expect(status.scope.active).toBe(false);
  });

  it("reports a matched allowlist when scope env is set", () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const status = getStatus(makeScopedConfig({ dbPath: fixture.path }));
    expect(status.unscoped).toBe(false);
    expect(status.scope.active).toBe(true);
    expect(status.scope.matched).toBe(true);
    expect(status.scope.chat?.display_name).toBe(GROUP_NAME);
  });

  it("reports NOT_FOUND when the path is missing", () => {
    const status = getStatus(
      makeConfig({ dbPath: join(tmpdir(), "definitely-missing-chat.db") }),
    );
    expect(status.readable).toBe(false);
    expect(status.error?.code).toBe("NOT_FOUND");
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports PERMISSION when the file is unreadable",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "apple-messages-perm-"));
      const path = join(dir, "chat.db");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, "not-a-db");
      chmodSync(path, 0);
      cleanups.push(() => {
        chmodSync(path, 0o644);
        rmSync(dir, { recursive: true, force: true });
      });
      const status = getStatus(makeConfig({ dbPath: path }));
      expect(status.fda_likely_missing).toBe(true);
      expect(status.error?.code).toBe("PERMISSION");
    },
  );
});

import { describe, expect, it } from "vitest";
import {
  isScopeActive,
  loadConfig,
  parseAllowlist,
  UNSCOPED_NOTE,
} from "../src/config.ts";

describe("scope config", () => {
  it("defaults to unscoped when no MESSAGES_SCOPE_* env is set", () => {
    const config = loadConfig({
      MESSAGES_DB_PATH: "/tmp/chat.db",
    } as NodeJS.ProcessEnv);
    expect(config.scopeDisplayName).toBeNull();
    expect(config.scopeChatId).toBeNull();
    expect(config.scopeAllowlist).toEqual([]);
    expect(isScopeActive(config)).toBe(false);
    expect(UNSCOPED_NOTE).toMatch(/All readable chats are available/);
  });

  it("treats an empty display-name env as unset, not a group title", () => {
    const config = loadConfig({
      MESSAGES_SCOPE_DISPLAY_NAME: "",
    } as NodeJS.ProcessEnv);
    expect(config.scopeDisplayName).toBeNull();
    expect(isScopeActive(config)).toBe(false);
  });

  it("parses an allowlist of names and chat ids", () => {
    expect(parseAllowlist("Weekend Plans, 12; Work")).toEqual([
      "Weekend Plans",
      "12",
      "Work",
    ]);
    const config = loadConfig({
      MESSAGES_SCOPE_ALLOWLIST: "Weekend Plans,12",
    } as NodeJS.ProcessEnv);
    expect(isScopeActive(config)).toBe(true);
    expect(config.scopeAllowlist).toEqual(["Weekend Plans", "12"]);
  });

  it("MESSAGES_ALLOW_UNSCOPED overrides an allowlist", () => {
    const config = loadConfig({
      MESSAGES_SCOPE_DISPLAY_NAME: "Weekend Plans",
      MESSAGES_ALLOW_UNSCOPED: "1",
    } as NodeJS.ProcessEnv);
    expect(config.scopeDisplayName).toBe("Weekend Plans");
    expect(isScopeActive(config)).toBe(false);
  });

  it("keeps ENABLE_SEND off by default", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).enableSend).toBe(false);
  });
});

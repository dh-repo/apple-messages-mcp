import { describe, expect, it } from "vitest";
import {
  isScopeActive,
  loadConfig,
  parseAllowlist,
  SCOPED_SHUT_NOTE,
  UNSCOPED_NOTE,
} from "../src/config.ts";

describe("scope config", () => {
  it("defaults to scoped shut when no env is set", () => {
    const config = loadConfig({
      MESSAGES_DB_PATH: "/tmp/chat.db",
    } as NodeJS.ProcessEnv);
    expect(config.scope).toEqual([]);
    expect(config.allowUnscoped).toBe(false);
    expect(isScopeActive(config)).toBe(true);
    expect(SCOPED_SHUT_NOTE).toMatch(/return SCOPE/);
  });

  it("treats an empty MESSAGES_SCOPE as unset, not a group title", () => {
    const config = loadConfig({
      MESSAGES_SCOPE: "",
    } as NodeJS.ProcessEnv);
    expect(config.scope).toEqual([]);
    expect(isScopeActive(config)).toBe(true);
  });

  it("parses MESSAGES_SCOPE tokens", () => {
    expect(parseAllowlist("Weekend Plans, 12; Work")).toEqual([
      "Weekend Plans",
      "12",
      "Work",
    ]);
    const config = loadConfig({
      MESSAGES_SCOPE: "Weekend Plans,12",
    } as NodeJS.ProcessEnv);
    expect(isScopeActive(config)).toBe(true);
    expect(config.scope).toEqual(["Weekend Plans", "12"]);
  });

  it("MESSAGES_ALLOW_UNSCOPED is the only whole-inbox switch", () => {
    const config = loadConfig({
      MESSAGES_SCOPE: "Weekend Plans",
      MESSAGES_ALLOW_UNSCOPED: "1",
    } as NodeJS.ProcessEnv);
    expect(config.scope).toEqual(["Weekend Plans"]);
    expect(isScopeActive(config)).toBe(false);
    expect(UNSCOPED_NOTE).toMatch(/MESSAGES_ALLOW_UNSCOPED=1/);
  });

  it("keeps ENABLE_SEND off by default", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).enableSend).toBe(false);
  });
});

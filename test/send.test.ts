import { afterEach, describe, expect, it } from "vitest";
import { actionSend } from "../src/actions.ts";
import {
  resetSendViaAppleScriptCalls,
  sendViaAppleScript,
  sendViaAppleScriptCalls,
} from "../src/send/applescript.ts";
import { MessagesError } from "../src/types.ts";
import {
  createFixtureDb,
  GROUP_NAME,
  makeConfig,
  makeUnscopedConfig,
} from "./helpers/fixture.ts";
import type { ChatSummary } from "../src/types.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  resetSendViaAppleScriptCalls();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const group: ChatSummary = {
  chat_id: 1,
  guid: "iMessage;+;chat111",
  chat_identifier: "chat111",
  display_name: GROUP_NAME,
  service: "iMessage",
  is_group: true,
  is_archived: false,
  handles: [],
  last_message_at: null,
  last_preview: null,
  message_count: 0,
};

describe("messages_send gate", () => {
  it("refuses to send when ENABLE_SEND is off", async () => {
    await expect(
      sendViaAppleScript({
        to: GROUP_NAME,
        body: "hello",
        chat: group,
        config: makeConfig({ dbPath: ":memory:", enableSend: false }),
      }),
    ).rejects.toMatchObject({ code: "SEND_DISABLED" } satisfies Partial<MessagesError>);
  });

  it("refuses send without confirm: true", async () => {
    await expect(
      actionSend(makeConfig({ dbPath: ":memory:", enableSend: true }), {
        to: GROUP_NAME,
        body: "hello",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" } satisfies Partial<MessagesError>);
  });

  it("dry_run returns { to, chat_id, guid, body } and does not call osascript", async () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const result = await actionSend(
      makeUnscopedConfig({ dbPath: fixture.path, enableSend: true }),
      { to: GROUP_NAME, body: "preview only", dry_run: true },
    );
    expect(result).toEqual({
      to: GROUP_NAME,
      chat_id: fixture.ids.groupChatId,
      guid: "iMessage;+;chat111",
      body: "preview only",
    });
    expect(result).not.toHaveProperty("via");
    expect(sendViaAppleScriptCalls).toBe(0);
  });

  it("still requires confirm: true when it would actually send", async () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    await expect(
      actionSend(makeUnscopedConfig({ dbPath: fixture.path, enableSend: true }), {
        to: GROUP_NAME,
        body: "hello",
        confirm: true,
      }),
    ).rejects.toMatchObject({
      code: process.platform === "darwin" ? "SEND_FAILED" : "UNSUPPORTED",
    });
  });

  it("does not call osascript on non-macOS even when enabled", async () => {
    await expect(
      sendViaAppleScript({
        to: GROUP_NAME,
        body: "hello",
        chat: group,
        config: makeConfig({ dbPath: ":memory:", enableSend: true }),
      }),
    ).rejects.toMatchObject({
      code: process.platform === "darwin" ? "SEND_FAILED" : "UNSUPPORTED",
    });
  });
});

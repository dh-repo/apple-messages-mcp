import { describe, expect, it } from "vitest";
import { actionSend } from "../src/actions.ts";
import { sendViaAppleScript } from "../src/send/applescript.ts";
import { MessagesError } from "../src/types.ts";
import { GROUP_NAME, makeConfig } from "./helpers/fixture.ts";
import type { ChatSummary } from "../src/types.ts";

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

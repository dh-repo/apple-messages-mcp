import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatSummary, Config } from "../types.ts";
import { MessagesError } from "../types.ts";
import { looksLikeHandle } from "../db/handles.ts";

const execFileAsync = promisify(execFile);

function escapeForDisplay(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/**
 * Send via Messages.app. No private APIs, no GUI scrape.
 * Requires Automation permission for the launching app (Cursor / Terminal).
 */
export async function sendViaAppleScript(opts: {
  to: string;
  body: string;
  chat: ChatSummary;
  config: Config;
}): Promise<{ ok: true; via: string; to: string }> {
  if (!opts.config.enableSend) {
    throw new MessagesError(
      "SEND_DISABLED",
      "messages_send is disabled. Set ENABLE_SEND=1 in the MCP server env only after you accept that the agent can send real iMessages.",
    );
  }
  if (process.platform !== "darwin") {
    throw new MessagesError(
      "UNSUPPORTED",
      "AppleScript send only works on macOS with Messages.app.",
    );
  }
  if (!opts.body.trim()) {
    throw new MessagesError("INVALID_ARGS", "body must be non-empty.");
  }

  const script = looksLikeHandle(opts.to) && !opts.chat.is_group
    ? buddyScript()
    : chatScript();

  try {
    await execFileAsync("osascript", ["-e", script, "--", opts.body, opts.to], {
      timeout: 20_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MessagesError(
      "SEND_FAILED",
      `osascript failed for ${escapeForDisplay(opts.to)}: ${message}. Grant Automation access to the app that launched this server.`,
    );
  }

  return {
    ok: true,
    via: looksLikeHandle(opts.to) && !opts.chat.is_group ? "buddy" : "chat",
    to: opts.to,
  };
}

function chatScript(): string {
  return `
on run argv
  set theBody to item 1 of argv
  set theTarget to item 2 of argv
  tell application "Messages"
    send theBody to chat theTarget
  end tell
end run
`.trim();
}

function buddyScript(): string {
  return `
on run argv
  set theBody to item 1 of argv
  set theTarget to item 2 of argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant theTarget of targetService
    send theBody to targetBuddy
  end tell
end run
`.trim();
}

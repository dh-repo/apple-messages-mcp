import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./types.ts";
import { MessagesError } from "./types.ts";
import { isScopeActive } from "./config.ts";
import {
  actionGetThread,
  actionListChats,
  actionSearch,
  actionSend,
  actionStatus,
} from "./actions.ts";
import { logInfo } from "./log.ts";

function jsonResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function errorResult(err: unknown) {
  if (err instanceof MessagesError) {
    return jsonResult({ error: { code: err.code, message: err.message } }, true);
  }
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult({ error: { code: "OPEN_FAILED", message } }, true);
}

export function registerTools(server: McpServer, config: Config): void {
  const scoped = isScopeActive(config);
  const scopeHint = scoped
    ? " An optional allowlist is active (MESSAGES_SCOPE_DISPLAY_NAME / MESSAGES_SCOPE_CHAT_ID / MESSAGES_SCOPE_ALLOWLIST); chats outside it are refused."
    : " No scope env is set, so every readable chat is available. Pass chat_id or handle when a thread is required.";

  server.registerTool(
    "messages_status",
    {
      title: "Messages status",
      description:
        "Report whether chat.db is readable, whether Full Disk Access is likely missing, macOS version hints, send/redact flags, and whether an optional chat allowlist is active. Call this first when anything fails. Does not return message bodies. When unscoped, scope.note says all readable chats are available.",
      inputSchema: z.object({}),
    },
    async () => {
      const status = actionStatus(config);
        logInfo("messages_status", {
        readable: status.readable,
        fda: status.fda_likely_missing,
        unscoped: status.unscoped,
        scoped: status.scope.active,
      });
      return jsonResult(status, !status.ok);
    },
  );

  server.registerTool(
    "messages_list_chats",
    {
      title: "List chats",
      description:
        `List recent conversations from the local Messages database (iMessage and SMS).` +
        scopeHint +
        " Returns chat_id (chat.ROWID), guid, handles (phone/email), and a last-message preview. Does not return attachment bytes.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max chats to return. Default 30."),
        query: z
          .string()
          .optional()
          .describe("Filter by display name, chat identifier, or handle."),
      }),
    },
    async ({ limit, query }) => {
      try {
        const result = actionListChats(config, { limit, query });
        logInfo("messages_list_chats", { count: result.chats.length });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "messages_get_thread",
    {
      title: "Get thread",
      description:
        `Return messages for one chat, oldest-first within the page.` +
        scopeHint +
        " Identify the chat with chat_id (chat.ROWID) or a participant handle (phone/email). If omitted and the allowlist has exactly one chat, that chat is used; otherwise chat_id or handle is required. before paginates: a message_id or ISO-8601 timestamp. Attachment metadata is included; file bytes are not. Tapbacks are omitted unless include_reactions is true.",
      inputSchema: z.object({
        chat_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("chat.ROWID. Prefer this over handle."),
        handle: z
          .string()
          .optional()
          .describe("Phone number or email of a participant."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
        before: z
          .union([z.number().int(), z.string()])
          .optional()
          .describe("Page older than this message_id or ISO timestamp."),
        include_reactions: z
          .boolean()
          .optional()
          .describe("Include tapback rows. Default false."),
      }),
    },
    async ({ chat_id, handle, limit, before, include_reactions }) => {
      try {
        const result = actionGetThread(config, {
          chat_id,
          handle,
          limit,
          before,
          include_reactions,
        });
        logInfo("messages_get_thread", {
          chat_id: result.chat.chat_id,
          count: result.messages.length,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "messages_search",
    {
      title: "Search messages",
      description:
        `Search message text (plain text column and decoded attributedBody) for a substring.` +
        scopeHint +
        " With no chat_id, searches across all readable chats (or the allowlist). Pass chat_id to target one thread. Case-insensitive. Does not search attachment binaries.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Substring to find."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
        chat_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Restrict to this chat.ROWID."),
      }),
    },
    async ({ query, limit, chat_id }) => {
      try {
        const result = actionSearch(config, { query, limit, chat_id });
        logInfo("messages_search", { count: result.messages.length });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "messages_send",
    {
      title: "Send message",
      description:
        `OPTIONAL. Sends a real iMessage/SMS through Messages.app via AppleScript. Disabled unless ENABLE_SEND=1.` +
        ` Confirm the recipient and exact body with the user before calling.` +
        (scoped
          ? " An allowlist is active; `to` must identify one of those chats."
          : " `to` is a group display name, chat guid, chat_id, or (1:1) phone/email.") +
        ` Requires Automation permission for the launching app. This is not a preview — it sends.`,
      inputSchema: z.object({
        to: z
          .string()
          .min(1)
          .describe(
            "Group display name, chat guid, chat_id, or (1:1) phone/email.",
          ),
        body: z.string().min(1).describe("Message text to send."),
      }),
    },
    async ({ to, body }) => {
      try {
        const sent = await actionSend(config, { to, body });
        logInfo("messages_send", { chat_id: sent.chat_id, via: sent.via });
        return jsonResult(sent);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

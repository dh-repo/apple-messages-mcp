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
    ? config.scope.length > 0
      ? " MESSAGES_SCOPE is active; chats outside it are refused."
      : " No MESSAGES_SCOPE and MESSAGES_ALLOW_UNSCOPED is unset; list/search/thread/send/watch return SCOPE."
    : " MESSAGES_ALLOW_UNSCOPED=1: every readable chat is available. Pass chat_id, guid, or handle when a thread is required.";

  server.registerTool(
    "messages_status",
    {
      title: "Messages status",
      description:
        "Report whether chat.db is readable, whether Full Disk Access is likely missing, macOS version hints, send/redact flags, snapshot size/age, and whether the inbox is scoped shut. Call this first when anything fails. Does not return message bodies. unscoped is true only when MESSAGES_ALLOW_UNSCOPED=1.",
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
        " Returns chat_id (chat.ROWID), guid, chat_identifier, handles (phone/email), and a last-message preview. Prefer guid to remember a thread across launches. Does not return attachment bytes.",
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
          .describe("Filter by display name, chat identifier, guid, or handle."),
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
        " Identify the chat with chat_id (chat.ROWID), guid (via handle field or chat_id), or a participant handle (phone/email). If omitted and the allowlist has exactly one chat, that chat is used. before paginates: a message_id or ISO-8601 timestamp. from_date / to_date filter on the converted Apple date. Attachment metadata is included; file bytes are not. Tapbacks are omitted unless include_reactions is true.",
      inputSchema: z.object({
        chat_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("chat.ROWID. Prefer guid from a previous response to remember a thread."),
        handle: z
          .string()
          .optional()
          .describe("Phone number, email, or chat guid of a participant / thread."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
        before: z
          .union([z.number().int(), z.string()])
          .optional()
          .describe("Page older than this message_id or ISO timestamp."),
        from_date: z.string().optional().describe("ISO-8601 inclusive lower bound."),
        to_date: z.string().optional().describe("ISO-8601 inclusive upper bound."),
        include_reactions: z
          .boolean()
          .optional()
          .describe("Include tapback rows. Default false."),
      }),
    },
    async ({ chat_id, handle, limit, before, from_date, to_date, include_reactions }) => {
      try {
        const result = actionGetThread(config, {
          chat_id,
          handle,
          limit,
          before,
          include_reactions,
          from_date,
          to_date,
        });
        logInfo("messages_get_thread", {
          chat_id: result.chat.chat_id,
          guid: result.chat.guid,
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
        `Search message text: SQL LIKE on the plain text column, then a bounded decode-scan of empty-text / Tahoe rows. Decoded Tahoe bodies live in a sidecar file we own (message_id, decoded_text), so they stay findable after leaving the scan window.` +
        scopeHint +
        " Returns truncated:true when an in-scope empty-text row has not been decoded yet. With no chat_id, searches across all readable chats (or the allowlist). Case-insensitive. Does not search attachment binaries. Does not write into chat.db. Does not FTS attributedBody.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Substring to find."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
        chat_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Restrict to this chat.ROWID."),
        from_date: z.string().optional().describe("ISO-8601 inclusive lower bound."),
        to_date: z.string().optional().describe("ISO-8601 inclusive upper bound."),
      }),
    },
    async ({ query, limit, chat_id, from_date, to_date }) => {
      try {
        const result = actionSearch(config, { query, limit, chat_id, from_date, to_date });
        logInfo("messages_search", {
          count: result.messages.length,
          truncated: result.truncated,
          scanned: result.scanned,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  if (!config.enableSend) {
    return;
  }

  server.registerTool(
    "messages_send",
    {
      title: "Send message",
      description:
        "Sends a real iMessage/SMS through Messages.app via AppleScript. dry_run: true returns { to, chat_id, guid, body } and does not call osascript. An actual send still requires confirm: true after the user accepted the exact recipient and body. `to` is resolved in-process to one in-scope chat (guid, handle, chat_id, or display name), then passed to osascript as argv." +
        (scoped ? " An allowlist is active; `to` must identify one of those chats." : "") +
        " Requires Automation permission for the launching app.",
      inputSchema: z.object({
        to: z
          .string()
          .min(1)
          .describe("Group display name, chat guid, chat_id, or (1:1) phone/email."),
        body: z.string().min(1).describe("Message text to send."),
        confirm: z
          .boolean()
          .optional()
          .describe("Required to actually send. Not required for dry_run."),
        dry_run: z
          .boolean()
          .optional()
          .describe("If true, resolve the target and return { to, chat_id, guid, body } without sending."),
      }),
    },
    async ({ to, body, confirm, dry_run }) => {
      try {
        const sent = await actionSend(config, { to, body, confirm, dry_run });
        if ("via" in sent) {
          logInfo("messages_send", { chat_id: sent.chat_id, guid: sent.guid, via: sent.via });
        } else {
          logInfo("messages_send_dry_run", { chat_id: sent.chat_id, guid: sent.guid });
        }
        return jsonResult(sent);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

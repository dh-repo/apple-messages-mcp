import type { ChatSummary, Config, MessageRow, StatusReport } from "./types.ts";
import { MessagesError } from "./types.ts";
import { isScopeActive } from "./config.ts";
import { withChatDb } from "./db/open.ts";
import {
  assertChatAllowed,
  findChatByRef,
  getChatById,
  getThread,
  listChats,
  resolveRequestedChat,
  resolveScope,
  searchMessages,
} from "./db/queries.ts";
import { looksLikeHandle } from "./db/handles.ts";
import { sendViaAppleScript } from "./send/applescript.ts";
import { getStatus } from "./status.ts";

export function actionStatus(config: Config): StatusReport {
  return getStatus(config);
}

export function actionListChats(
  config: Config,
  args: { limit?: number; query?: string },
): {
  scope: ReturnType<typeof resolveScope>;
  chats: ChatSummary[];
  hint?: string;
} {
  return withChatDb(config.dbPath, config.dbMode, (db) => {
    const scope = resolveScope(db, config);
    if (isScopeActive(config)) {
      if (!scope.matched) {
        return {
          scope,
          chats: [],
          hint: `Allowlist ${scope.allowlist.join(", ") || "(empty)"} matched no chats. Use messages_status.scope.candidates to pick a display_name or chat_id.`,
        };
      }
      const chats = scope.chats.filter((chat) => {
        if (!args.query) return true;
        const q = args.query.toLowerCase();
        return (
          chat.display_name?.toLowerCase().includes(q) ||
          chat.chat_identifier?.toLowerCase().includes(q) ||
          chat.handles.some((h) => h.id.toLowerCase().includes(q))
        );
      });
      return { scope, chats };
    }
    return {
      scope,
      chats: listChats(db, {
        limit: args.limit,
        query: args.query,
        redact: config.redactPreviews,
      }),
    };
  });
}

export function actionGetThread(
  config: Config,
  args: {
    chat_id?: number;
    handle?: string;
    limit?: number;
    before?: string | number;
    include_reactions?: boolean;
  },
): { chat: ChatSummary; messages: MessageRow[] } {
  return withChatDb(config.dbPath, config.dbMode, (db) => {
    const { chat } = resolveRequestedChat(db, config, {
      chat_id: args.chat_id,
      handle: args.handle,
    });
    const messages = getThread(db, {
      chatId: chat.chat_id,
      limit: args.limit,
      before: args.before,
      redact: config.redactPreviews,
      includeReactions: args.include_reactions,
    });
    return { chat, messages };
  });
}

export function actionSearch(
  config: Config,
  args: { query: string; limit?: number; chat_id?: number },
): { chat_id: number | null; chat_ids: number[] | null; query: string; messages: MessageRow[] } {
  return withChatDb(config.dbPath, config.dbMode, (db) => {
    const scope = resolveScope(db, config);
    let chatId = args.chat_id;
    let chatIds: number[] | undefined;
    if (args.chat_id !== undefined) {
      const chat = getChatById(db, args.chat_id, config.redactPreviews);
      if (!chat) {
        throw new MessagesError("NOT_FOUND", `No chat with chat_id ${args.chat_id}.`);
      }
      assertChatAllowed(config, scope, chat);
    } else if (isScopeActive(config)) {
      if (!scope.matched) {
        throw new MessagesError(
          "SCOPE",
          `Allowlist ${scope.allowlist.join(", ") || "(empty)"} matched no chats.`,
        );
      }
      if (scope.chats.length === 1) {
        chatId = scope.chats[0]?.chat_id;
      } else {
        chatIds = scope.chats.map((chat) => chat.chat_id);
      }
    }
    const messages = searchMessages(db, {
      query: args.query,
      chatId,
      chatIds,
      limit: args.limit,
      redact: config.redactPreviews,
    });
    return {
      chat_id: chatId ?? null,
      chat_ids: chatIds ?? (chatId !== undefined ? [chatId] : null),
      query: args.query,
      messages,
    };
  });
}

export async function actionSend(
  config: Config,
  args: { to: string; body: string },
): Promise<{
  ok: true;
  via: string;
  to: string;
  chat_id: number;
  note: string;
}> {
  const chat = withChatDb(config.dbPath, config.dbMode, (db) => {
    if (looksLikeHandle(args.to)) {
      return resolveRequestedChat(db, config, { handle: args.to }).chat;
    }
    return findChatByRef(db, config, args.to);
  });

  const sent = await sendViaAppleScript({
    to: looksLikeHandle(args.to) && !chat.is_group ? args.to : (chat.display_name ?? args.to),
    body: args.body,
    chat,
    config,
  });
  return {
    ...sent,
    chat_id: chat.chat_id,
    note: "Sent via Messages.app. Delivery depends on Apple's service, not this connector.",
  };
}

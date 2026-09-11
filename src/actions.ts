import type { ChatSummary, Config, MessageRow, SearchResult, StatusReport } from "./types.ts";
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
import { getProcessSidecar } from "./db/sidecar.ts";
import { sendViaAppleScript } from "./send/applescript.ts";
import { getStatus } from "./status.ts";

function throwIfUnmatchedScope(scope: ReturnType<typeof resolveScope>): void {
  if (!scope.active || scope.matched) return;
  throw new MessagesError(
    "SCOPE",
    `Allowlist ${scope.allowlist.join(", ") || "(empty)"} matched no chats. Group name candidates: ${scope.candidates
      .map((c) => `${c.chat_id}:${c.display_name}`)
      .join("; ") || "(none)"}`,
  );
}

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
      throwIfUnmatchedScope(scope);
      const chats = listChats(db, {
        limit: args.limit,
        query: args.query,
        redact: config.redactPreviews,
        chatIds: scope.chats.map((chat) => chat.chat_id),
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
    from_date?: string;
    to_date?: string;
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
      fromDate: args.from_date,
      toDate: args.to_date,
    });
    return { chat, messages };
  });
}

export function actionSearch(
  config: Config,
  args: { query: string; limit?: number; chat_id?: number; from_date?: string; to_date?: string },
): {
  chat_id: number | null;
  chat_ids: number[] | null;
  query: string;
  messages: MessageRow[];
  truncated: boolean;
  scanned: number;
} {
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
      throwIfUnmatchedScope(scope);
      if (scope.chats.length === 1) {
        chatId = scope.chats[0]?.chat_id;
      } else {
        chatIds = scope.chats.map((chat) => chat.chat_id);
      }
    }
    const result: SearchResult = searchMessages(db, {
      query: args.query,
      chatId,
      chatIds,
      limit: args.limit,
      redact: config.redactPreviews,
      fromDate: args.from_date,
      toDate: args.to_date,
      sidecar: getProcessSidecar(config.dbPath),
    });
    return {
      chat_id: chatId ?? null,
      chat_ids: chatIds ?? (chatId !== undefined ? [chatId] : null),
      query: args.query,
      messages: result.messages,
      truncated: result.truncated,
      scanned: result.scanned,
    };
  });
}

export type SendDryRun = {
  to: string;
  chat_id: number;
  guid: string;
  body: string;
};

export type SendAccepted = {
  ok: true;
  via: string;
  to: string;
  chat_id: number;
  guid: string;
  note: string;
};

export async function actionSend(
  config: Config,
  args: { to: string; body: string; confirm?: boolean; dry_run?: boolean },
): Promise<SendDryRun | SendAccepted> {
  if (!config.enableSend) {
    throw new MessagesError(
      "SEND_DISABLED",
      "messages_send is disabled. Set ENABLE_SEND=1 only after you accept that the agent can send real iMessages.",
    );
  }
  if (args.dry_run !== true && args.confirm !== true) {
    throw new MessagesError(
      "INVALID_ARGS",
      "messages_send requires confirm: true after the user accepted the exact recipient and body.",
    );
  }

  const chat = withChatDb(config.dbPath, config.dbMode, (db) => {
    if (looksLikeHandle(args.to)) {
      return resolveRequestedChat(db, config, { handle: args.to }).chat;
    }
    return findChatByRef(db, config, args.to);
  });

  const resolvedTo =
    looksLikeHandle(args.to) && !chat.is_group ? args.to : (chat.display_name ?? args.to);

  if (args.dry_run === true) {
    return {
      to: resolvedTo,
      chat_id: chat.chat_id,
      guid: chat.guid,
      body: args.body,
    };
  }

  const sent = await sendViaAppleScript({
    to: resolvedTo,
    body: args.body,
    chat,
    config,
  });
  return {
    ...sent,
    chat_id: chat.chat_id,
    guid: chat.guid,
    note: "Sent via Messages.app. Delivery depends on Apple's service, not this connector.",
  };
}

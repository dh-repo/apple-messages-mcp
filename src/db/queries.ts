import type { DatabaseSync } from "node:sqlite";
import { resolveMessageText } from "../decode/attributedBody.ts";
import { maybeRedact } from "../redact.ts";
import { ALLOWLIST_NOTE, isScopeActive, UNSCOPED_NOTE } from "../config.ts";
import type {
  AttachmentMeta,
  ChatSummary,
  Config,
  Handle,
  MessageRow,
  ScopeMatch,
} from "../types.ts";
import { MessagesError } from "../types.ts";
import { appleDateToIso, isoToAppleNanos, isIsoDate } from "./dates.ts";
import { handlesMatch } from "./handles.ts";
import { listTables, tableColumns } from "./open.ts";

const DEFAULT_CHAT_LIMIT = 30;
const MAX_CHAT_LIMIT = 100;
const DEFAULT_THREAD_LIMIT = 50;
const MAX_THREAD_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function asAppleDate(value: unknown): string | bigint | number | null {
  if (typeof value === "string" || typeof value === "bigint" || typeof value === "number") {
    return value;
  }
  return null;
}

function asBlob(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function hasColumn(cols: Set<string>, name: string): boolean {
  return cols.has(name);
}

function isGroupChat(args: {
  style: number | null;
  displayName: string | null;
  identifier: string | null;
  handleCount: number;
}): boolean {
  if (args.style === 43) return true;
  if (args.displayName && args.displayName.trim() !== "") return true;
  if (args.identifier?.toLowerCase().startsWith("chat")) return true;
  return args.handleCount > 1;
}

function namesSimilar(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

export function collectScopeTokens(config: Config): string[] {
  const tokens: string[] = [];
  if (config.scopeDisplayName) tokens.push(config.scopeDisplayName);
  if (config.scopeChatId !== null) tokens.push(String(config.scopeChatId));
  for (const item of config.scopeAllowlist) tokens.push(item);
  return [...new Set(tokens)];
}

export function chatMatchesToken(chat: ChatSummary, token: string): boolean {
  if (/^\d+$/.test(token) && chat.chat_id === Number(token)) return true;
  if (chat.display_name && namesSimilar(chat.display_name, token)) return true;
  if (chat.display_name?.toLowerCase().includes(token.toLowerCase())) return true;
  if (chat.chat_identifier && namesSimilar(chat.chat_identifier, token)) return true;
  if (namesSimilar(chat.guid, token)) return true;
  return false;
}

export function emptyScope(config: Config): ScopeMatch {
  const active = isScopeActive(config);
  return {
    active,
    mode: active ? "allowlist" : "unscoped",
    note: active ? ALLOWLIST_NOTE : UNSCOPED_NOTE,
    configured_name: config.scopeDisplayName,
    configured_chat_id: config.scopeChatId,
    allowlist: collectScopeTokens(config),
    matched: !active,
    chat: null,
    chats: [],
    candidates: [],
  };
}

export function loadHandlesForChat(db: DatabaseSync, chatId: number): Handle[] {
  const tables = new Set(listTables(db));
  if (!tables.has("chat_handle_join") || !tables.has("handle")) return [];
  const handleCols = tableColumns(db, "handle");
  const countrySel = hasColumn(handleCols, "country") ? "h.country" : "NULL AS country";
  const rows = db
    .prepare(
      `SELECT h.ROWID AS handle_id, h.id, h.service, ${countrySel}
       FROM chat_handle_join j
       JOIN handle h ON h.ROWID = j.handle_id
       WHERE j.chat_id = ?
       ORDER BY h.ROWID`,
    )
    .all(chatId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    handle_id: asNumber(row.handle_id) ?? 0,
    id: asString(row.id) ?? "",
    service: asString(row.service) ?? "",
    country: asString(row.country),
  }));
}

function mapChat(
  db: DatabaseSync,
  row: Record<string, unknown>,
  redact: boolean,
): ChatSummary {
  const chatId = asNumber(row.chat_id) ?? 0;
  const handles = loadHandlesForChat(db, chatId);
  const displayName = asString(row.display_name);
  const identifier = asString(row.chat_identifier);
  const style = asNumber(row.style);
  const resolved = resolveMessageText(
    asString(row.last_text),
    asBlob(row.last_attributed_body),
  );

  return {
    chat_id: chatId,
    guid: asString(row.guid) ?? "",
    chat_identifier: identifier,
    display_name: displayName,
    service: asString(row.service_name),
    is_group: isGroupChat({
      style,
      displayName,
      identifier,
      handleCount: handles.length,
    }),
    is_archived: (asNumber(row.is_archived) ?? 0) === 1,
    handles,
    last_message_at: appleDateToIso(asAppleDate(row.last_date)),
    last_preview: resolved.text ? maybeRedact(resolved.text, redact) : null,
    message_count: asNumber(row.message_count) ?? 0,
  };
}

function chatSelectSql(chatCols: Set<string>, messageCols: Set<string>): string {
  const display = hasColumn(chatCols, "display_name")
    ? "c.display_name"
    : "NULL AS display_name";
  const identifier = hasColumn(chatCols, "chat_identifier")
    ? "c.chat_identifier"
    : "NULL AS chat_identifier";
  const service = hasColumn(chatCols, "service_name")
    ? "c.service_name"
    : "NULL AS service_name";
  const archived = hasColumn(chatCols, "is_archived")
    ? "c.is_archived"
    : "0 AS is_archived";
  const style = hasColumn(chatCols, "style") ? "c.style" : "NULL AS style";
  const lastText = hasColumn(messageCols, "text")
    ? "lm.text AS last_text"
    : "NULL AS last_text";
  const lastBody = hasColumn(messageCols, "attributedBody")
    ? "lm.attributedBody AS last_attributed_body"
    : "NULL AS last_attributed_body";

  return `
    SELECT
      c.ROWID AS chat_id,
      c.guid,
      ${identifier},
      ${display},
      ${service},
      ${archived},
      ${style},
      (
        SELECT COUNT(*)
        FROM chat_message_join cmj_c
        WHERE cmj_c.chat_id = c.ROWID
      ) AS message_count,
      CAST((
        SELECT MAX(m.date)
        FROM chat_message_join cmj_d
        JOIN message m ON m.ROWID = cmj_d.message_id
        WHERE cmj_d.chat_id = c.ROWID
      ) AS TEXT) AS last_date,
      lm.ROWID AS last_message_id,
      ${lastText},
      ${lastBody}
    FROM chat c
    LEFT JOIN message lm ON lm.ROWID = (
      SELECT m2.ROWID
      FROM chat_message_join cmj2
      JOIN message m2 ON m2.ROWID = cmj2.message_id
      WHERE cmj2.chat_id = c.ROWID
      ORDER BY m2.date DESC, m2.ROWID DESC
      LIMIT 1
    )
  `;
}

export function listChats(
  db: DatabaseSync,
  opts: { limit?: number; query?: string; redact: boolean },
): ChatSummary[] {
  const tables = new Set(listTables(db));
  if (!tables.has("chat") || !tables.has("message") || !tables.has("chat_message_join")) {
    throw new MessagesError(
      "OPEN_FAILED",
      "chat.db is missing required tables (chat, message, chat_message_join).",
    );
  }

  const sql = `${chatSelectSql(tableColumns(db, "chat"), tableColumns(db, "message"))}
    ORDER BY last_date DESC, c.ROWID DESC
    LIMIT ?`;
  const rows = db.prepare(sql).all(clamp(opts.limit, DEFAULT_CHAT_LIMIT, MAX_CHAT_LIMIT)) as Array<
    Record<string, unknown>
  >;

  let chats = rows.map((row) => mapChat(db, row, opts.redact));
  const query = opts.query?.trim();
  if (query) {
    const q = query.toLowerCase();
    chats = chats.filter((chat) => {
      if (chat.display_name?.toLowerCase().includes(q)) return true;
      if (chat.chat_identifier?.toLowerCase().includes(q)) return true;
      if (chat.guid.toLowerCase().includes(q)) return true;
      return chat.handles.some(
        (handle) =>
          handle.id.toLowerCase().includes(q) || handlesMatch(handle.id, query),
      );
    });
  }
  return chats;
}

export function getChatById(
  db: DatabaseSync,
  chatId: number,
  redact: boolean,
): ChatSummary | null {
  const tables = new Set(listTables(db));
  if (!tables.has("chat")) return null;
  const sql = `${chatSelectSql(tableColumns(db, "chat"), tableColumns(db, "message"))}
    WHERE c.ROWID = ?
    LIMIT 1`;
  const row = db.prepare(sql).get(chatId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapChat(db, row, redact);
}

export function resolveScope(db: DatabaseSync, config: Config): ScopeMatch {
  const base = emptyScope(config);
  if (!base.active) {
    return { ...base, candidates: [] };
  }

  const tokens = collectScopeTokens(config);
  const chats = listChats(db, { limit: MAX_CHAT_LIMIT, redact: config.redactPreviews });
  const matched = chats.filter((chat) =>
    tokens.some((token) => chatMatchesToken(chat, token)),
  );
  const candidates = matched.length > 0 ? [] : listGroupNameCandidates(db);
  return {
    ...base,
    matched: matched.length > 0,
    chat: matched[0] ?? null,
    chats: matched,
    candidates,
  };
}

export function listGroupNameCandidates(
  db: DatabaseSync,
): Array<{ chat_id: number; display_name: string }> {
  const tables = new Set(listTables(db));
  if (!tables.has("chat")) return [];
  const cols = tableColumns(db, "chat");
  if (!hasColumn(cols, "display_name")) return [];
  const rows = db
    .prepare(
      `SELECT ROWID AS chat_id, display_name
       FROM chat
       WHERE display_name IS NOT NULL AND trim(display_name) != ''
       ORDER BY ROWID DESC
       LIMIT 40`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    chat_id: asNumber(row.chat_id) ?? 0,
    display_name: asString(row.display_name) ?? "",
  }));
}

export function assertChatAllowed(
  config: Config,
  scope: ScopeMatch,
  chat: ChatSummary,
): void {
  if (!isScopeActive(config)) return;
  if (scope.chats.some((allowed) => allowed.chat_id === chat.chat_id)) return;
  const tokens = collectScopeTokens(config);
  if (tokens.some((token) => chatMatchesToken(chat, token))) return;
  throw new MessagesError(
    "SCOPE",
    `Refusing chat_id ${chat.chat_id} (${chat.display_name ?? chat.chat_identifier ?? chat.guid}). This server is restricted to allowlist: ${tokens.join(", ") || "(empty)"}.`,
  );
}

function findChatsForHandle(db: DatabaseSync, handle: string, redact: boolean): ChatSummary[] {
  const chats = listChats(db, { limit: MAX_CHAT_LIMIT, redact });
  return chats.filter((chat) => chat.handles.some((h) => handlesMatch(h.id, handle)));
}

export function resolveRequestedChat(
  db: DatabaseSync,
  config: Config,
  args: { chat_id?: number; handle?: string },
): { chat: ChatSummary; scope: ScopeMatch } {
  const scope = resolveScope(db, config);

  if (args.chat_id !== undefined) {
    const chat = getChatById(db, args.chat_id, config.redactPreviews);
    if (!chat) {
      throw new MessagesError("NOT_FOUND", `No chat with chat_id ${args.chat_id}.`);
    }
    assertChatAllowed(config, scope, chat);
    return { chat, scope };
  }

  if (args.handle) {
    const matches = findChatsForHandle(db, args.handle, config.redactPreviews);
    const allowed = isScopeActive(config)
      ? matches.filter((chat) => {
          try {
            assertChatAllowed(config, scope, chat);
            return true;
          } catch {
            return false;
          }
        })
      : matches;
    if (allowed.length === 0) {
      throw new MessagesError(
        "NOT_FOUND",
        `No in-scope chat contains handle ${args.handle}.`,
      );
    }
    if (allowed.length > 1) {
      throw new MessagesError(
        "INVALID_ARGS",
        `Handle ${args.handle} matches ${allowed.length} chats: ${allowed
          .map((c) => c.chat_id)
          .join(", ")}. Pass chat_id.`,
      );
    }
    const chat = allowed[0]!;
    assertChatAllowed(config, scope, chat);
    return { chat, scope };
  }

  if (scope.active && scope.chats.length === 1 && scope.chat) {
    return { chat: scope.chat, scope };
  }
  if (scope.active && !scope.matched) {
    throw new MessagesError(
      "SCOPE",
      `Allowlist ${scope.allowlist.join(", ") || "(empty)"} matched no chats. Group name candidates: ${scope.candidates
        .map((c) => `${c.chat_id}:${c.display_name}`)
        .join("; ") || "(none)"}`,
    );
  }
  if (scope.active && scope.chats.length > 1) {
    throw new MessagesError(
      "INVALID_ARGS",
      `Allowlist matches ${scope.chats.length} chats. Pass chat_id or handle.`,
    );
  }
  throw new MessagesError(
    "INVALID_ARGS",
    "Pass chat_id or handle. This server is unscoped, so it will not guess a thread.",
  );
}

function loadAttachments(db: DatabaseSync, messageId: number): AttachmentMeta[] {
  const tables = new Set(listTables(db));
  if (!tables.has("attachment") || !tables.has("message_attachment_join")) return [];
  const cols = tableColumns(db, "attachment");
  const filename = hasColumn(cols, "filename") ? "a.filename" : "NULL AS filename";
  const mime = hasColumn(cols, "mime_type") ? "a.mime_type" : "NULL AS mime_type";
  const transfer = hasColumn(cols, "transfer_name")
    ? "a.transfer_name"
    : "NULL AS transfer_name";
  const bytes = hasColumn(cols, "total_bytes") ? "a.total_bytes" : "NULL AS total_bytes";
  const rows = db
    .prepare(
      `SELECT a.ROWID AS attachment_id, ${filename}, ${mime}, ${transfer}, ${bytes}
       FROM message_attachment_join j
       JOIN attachment a ON a.ROWID = j.attachment_id
       WHERE j.message_id = ?`,
    )
    .all(messageId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    attachment_id: asNumber(row.attachment_id) ?? 0,
    filename: asString(row.filename),
    mime_type: asString(row.mime_type),
    transfer_name: asString(row.transfer_name),
    total_bytes: asNumber(row.total_bytes),
  }));
}

function mapMessage(
  db: DatabaseSync,
  row: Record<string, unknown>,
  redact: boolean,
): MessageRow {
  const messageId = asNumber(row.message_id) ?? 0;
  const resolved = resolveMessageText(asString(row.text), asBlob(row.attributedBody));
  return {
    message_id: messageId,
    chat_id: asNumber(row.chat_id) ?? 0,
    guid: asString(row.guid),
    from_me: (asNumber(row.is_from_me) ?? 0) === 1,
    handle_id: asNumber(row.handle_id),
    handle: asString(row.handle_id_text),
    text: maybeRedact(resolved.text, redact),
    text_source: resolved.source,
    sent_at: appleDateToIso(asAppleDate(row.date)),
    service: asString(row.service),
    has_attachments: (asNumber(row.cache_has_attachments) ?? 0) === 1,
    attachments: loadAttachments(db, messageId),
  };
}

function messageSelectSql(messageCols: Set<string>, handleCols: Set<string>): string {
  const text = hasColumn(messageCols, "text") ? "m.text" : "NULL AS text";
  const body = hasColumn(messageCols, "attributedBody")
    ? "m.attributedBody"
    : "NULL AS attributedBody";
  const service = hasColumn(messageCols, "service") ? "m.service" : "NULL AS service";
  const assoc = hasColumn(messageCols, "associated_message_type")
    ? "m.associated_message_type"
    : "0 AS associated_message_type";
  const itemType = hasColumn(messageCols, "item_type") ? "m.item_type" : "0 AS item_type";
  const attach = hasColumn(messageCols, "cache_has_attachments")
    ? "m.cache_has_attachments"
    : "0 AS cache_has_attachments";
  const handleText =
    hasColumn(handleCols, "id") ? "h.id AS handle_id_text" : "NULL AS handle_id_text";

  return `
    SELECT
      m.ROWID AS message_id,
      cmj.chat_id AS chat_id,
      m.guid,
      ${text},
      ${body},
      CAST(m.date AS TEXT) AS date,
      m.is_from_me,
      m.handle_id,
      ${handleText},
      ${service},
      ${assoc},
      ${itemType},
      ${attach}
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN handle h ON h.ROWID = m.handle_id
  `;
}

export function getThread(
  db: DatabaseSync,
  opts: {
    chatId: number;
    limit?: number;
    before?: string | number;
    redact: boolean;
    includeReactions?: boolean;
  },
): MessageRow[] {
  const messageCols = tableColumns(db, "message");
  const handleCols = tableColumns(db, "handle");
  const clauses = ["cmj.chat_id = ?"];
  const params: Array<string | number> = [opts.chatId];

  if (!opts.includeReactions && hasColumn(messageCols, "associated_message_type")) {
    clauses.push("(m.associated_message_type IS NULL OR m.associated_message_type = 0)");
  }
  if (hasColumn(messageCols, "item_type")) {
    clauses.push("(m.item_type IS NULL OR m.item_type = 0)");
  }

  if (opts.before !== undefined && opts.before !== "") {
    if (typeof opts.before === "number" || /^-?\d+$/.test(String(opts.before))) {
      clauses.push("m.ROWID < ?");
      params.push(Number(opts.before));
    } else if (typeof opts.before === "string" && isIsoDate(opts.before)) {
      clauses.push("m.date < ?");
      params.push(isoToAppleNanos(opts.before).toString());
    } else {
      throw new MessagesError(
        "INVALID_ARGS",
        "before must be a message_id (number) or an ISO-8601 timestamp.",
      );
    }
  }

  const limit = clamp(opts.limit, DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);
  const sql = `${messageSelectSql(messageCols, handleCols)}
    WHERE ${clauses.join(" AND ")}
    ORDER BY m.date DESC, m.ROWID DESC
    LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => mapMessage(db, row, opts.redact)).reverse();
}

export function findChatByRef(
  db: DatabaseSync,
  config: Config,
  ref: string,
): ChatSummary {
  const scope = resolveScope(db, config);
  const chats = isScopeActive(config)
    ? scope.chats
    : listChats(db, { limit: MAX_CHAT_LIMIT, redact: config.redactPreviews });
  const matches = chats.filter(
    (chat) =>
      chatMatchesToken(chat, ref) ||
      String(chat.chat_id) === ref ||
      chat.guid === ref,
  );
  if (matches.length === 0) {
    throw new MessagesError("NOT_FOUND", `No in-scope chat matches "${ref}".`);
  }
  if (matches.length > 1) {
    throw new MessagesError(
      "INVALID_ARGS",
      `"${ref}" matches ${matches.length} chats. Pass a chat_id.`,
    );
  }
  const chat = matches[0]!;
  assertChatAllowed(config, scope, chat);
  return chat;
}

export function searchMessages(
  db: DatabaseSync,
  opts: {
    query: string;
    chatId?: number;
    chatIds?: number[];
    limit?: number;
    redact: boolean;
  },
): MessageRow[] {
  const query = opts.query.trim();
  if (!query) {
    throw new MessagesError("INVALID_ARGS", "query must be a non-empty string.");
  }

  const messageCols = tableColumns(db, "message");
  const handleCols = tableColumns(db, "handle");
  const clauses = ["1=1"];
  const params: Array<string | number> = [];

  if (opts.chatId !== undefined) {
    clauses.push("cmj.chat_id = ?");
    params.push(opts.chatId);
  } else if (opts.chatIds && opts.chatIds.length > 0) {
    clauses.push(`cmj.chat_id IN (${opts.chatIds.map(() => "?").join(", ")})`);
    params.push(...opts.chatIds);
  }
  if (hasColumn(messageCols, "associated_message_type")) {
    clauses.push("(m.associated_message_type IS NULL OR m.associated_message_type = 0)");
  }
  if (hasColumn(messageCols, "item_type")) {
    clauses.push("(m.item_type IS NULL OR m.item_type = 0)");
  }

  const scanLimit = Math.max(clamp(opts.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT) * 20, 200);
  const sql = `${messageSelectSql(messageCols, handleCols)}
    WHERE ${clauses.join(" AND ")}
    ORDER BY m.date DESC, m.ROWID DESC
    LIMIT ?`;
  params.push(scanLimit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const needle = query.toLowerCase();
  const matched: MessageRow[] = [];
  const limit = clamp(opts.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

  for (const row of rows) {
    const mapped = mapMessage(db, row, false);
    if (mapped.text.toLowerCase().includes(needle)) {
      matched.push({
        ...mapped,
        text: maybeRedact(mapped.text, opts.redact),
      });
    }
    if (matched.length >= limit) break;
  }
  return matched;
}

export type ChatWatermark = {
  chat_id: number;
  newest_message_id: number | null;
  newest_at: string | null;
  count: number;
};

/** High-water mark for the Phase 2 watcher. IDs only — no message text. */
export function getChatWatermark(
  db: DatabaseSync,
  chatIds: number[] | null,
): ChatWatermark {
  const where =
    chatIds === null
      ? "1=1"
      : chatIds.length === 0
        ? "0"
        : `cmj.chat_id IN (${chatIds.map(() => "?").join(", ")})`;
  const params: number[] = chatIds ?? [];
  const row = db
    .prepare(
      `SELECT
         CAST(MAX(m.ROWID) AS TEXT) AS newest_message_id,
         CAST(MAX(m.date) AS TEXT) AS newest_date,
         COUNT(*) AS count
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE ${where}`,
    )
    .get(...params) as Record<string, unknown> | undefined;

  let chatId: number | null = chatIds && chatIds.length === 1 ? (chatIds[0] ?? null) : null;
  const newestId = asNumber(row?.newest_message_id);
  if (newestId !== null && chatId === null) {
    const owner = db
      .prepare(
        `SELECT cmj.chat_id AS chat_id
         FROM chat_message_join cmj
         WHERE cmj.message_id = ?
         LIMIT 1`,
      )
      .get(newestId) as Record<string, unknown> | undefined;
    chatId = asNumber(owner?.chat_id);
  }

  return {
    chat_id: chatId ?? 0,
    newest_message_id: newestId,
    newest_at: appleDateToIso(asAppleDate(row?.newest_date)),
    count: asNumber(row?.count) ?? 0,
  };
}

export function countMessagesAfter(
  db: DatabaseSync,
  chatIds: number[] | null,
  afterMessageId: number,
): number {
  const where =
    chatIds === null
      ? "m.ROWID > ?"
      : chatIds.length === 0
        ? "0"
        : `cmj.chat_id IN (${chatIds.map(() => "?").join(", ")}) AND m.ROWID > ?`;
  const params: number[] =
    chatIds === null ? [afterMessageId] : [...chatIds, afterMessageId];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE ${where}`,
    )
    .get(...params) as Record<string, unknown> | undefined;
  return asNumber(row?.n) ?? 0;
}

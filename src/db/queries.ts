import type { DatabaseSync } from "node:sqlite";
import { resolveMessageText } from "../decode/attributedBody.ts";
import { maybeRedact } from "../redact.ts";
import { ALLOWLIST_NOTE, isScopeActive, SCOPED_SHUT_NOTE, UNSCOPED_NOTE } from "../config.ts";
import type {
  AttachmentMeta,
  ChatSummary,
  Config,
  Handle,
  MessageRow,
  ScopeMatch,
  SearchResult,
} from "../types.ts";
import { MessagesError } from "../types.ts";
import { appleDateToIso, isoToAppleNanos, isIsoDate } from "./dates.ts";
import { handlesMatch, looksLikeHandle } from "./handles.ts";
import { listTables, tableColumns } from "./open.ts";
import type { DecodeSidecar } from "./sidecar.ts";
import { syncSidecarWithLiveMax } from "./sidecar.ts";

const DEFAULT_CHAT_LIMIT = 30;
const MAX_CHAT_LIMIT = 100;
const DEFAULT_THREAD_LIMIT = 50;
const MAX_THREAD_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;
const TAHOE_SCAN_FLOOR = 200;

export type ChatIdentity = {
  chat_id: number;
  guid: string;
  chat_identifier: string | null;
  display_name: string | null;
  service: string | null;
  is_archived: boolean;
  handles: Handle[];
  style: number | null;
};

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
  return [...new Set(config.scope)];
}

function configuredName(tokens: string[]): string | null {
  return tokens.find((token) => !/^\d+$/.test(token)) ?? null;
}

function configuredChatId(tokens: string[]): number | null {
  const token = tokens.find((item) => /^\d+$/.test(item));
  return token ? Number(token) : null;
}

export function chatMatchesToken(chat: ChatSummary | ChatIdentity, token: string): boolean {
  if (/^\d+$/.test(token) && chat.chat_id === Number(token)) return true;
  if (chat.display_name && namesSimilar(chat.display_name, token)) return true;
  if (chat.display_name?.toLowerCase().includes(token.toLowerCase())) return true;
  if (chat.chat_identifier && namesSimilar(chat.chat_identifier, token)) return true;
  if (namesSimilar(chat.guid, token)) return true;
  return false;
}

function identityToSummary(identity: ChatIdentity): ChatSummary {
  return {
    chat_id: identity.chat_id,
    guid: identity.guid,
    chat_identifier: identity.chat_identifier,
    display_name: identity.display_name,
    service: identity.service,
    is_group: isGroupChat({
      style: identity.style,
      displayName: identity.display_name,
      identifier: identity.chat_identifier,
      handleCount: identity.handles.length,
    }),
    is_archived: identity.is_archived,
    handles: identity.handles,
    last_message_at: null,
    last_preview: null,
    message_count: 0,
  };
}

export function emptyScope(config: Config): ScopeMatch {
  const active = isScopeActive(config);
  const tokens = collectScopeTokens(config);
  const shut = active && tokens.length === 0;
  return {
    active,
    mode: active ? "allowlist" : "unscoped",
    note: !active ? UNSCOPED_NOTE : shut ? SCOPED_SHUT_NOTE : ALLOWLIST_NOTE,
    configured_name: configuredName(tokens),
    configured_chat_id: configuredChatId(tokens),
    allowlist: tokens,
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

function loadAllHandlesByChat(db: DatabaseSync): Map<number, Handle[]> {
  const map = new Map<number, Handle[]>();
  const tables = new Set(listTables(db));
  if (!tables.has("chat_handle_join") || !tables.has("handle")) return map;
  const handleCols = tableColumns(db, "handle");
  const countrySel = hasColumn(handleCols, "country") ? "h.country" : "NULL AS country";
  const rows = db
    .prepare(
      `SELECT j.chat_id AS chat_id, h.ROWID AS handle_id, h.id, h.service, ${countrySel}
       FROM chat_handle_join j
       JOIN handle h ON h.ROWID = j.handle_id
       ORDER BY j.chat_id, h.ROWID`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const chatId = asNumber(row.chat_id) ?? 0;
    const list = map.get(chatId) ?? [];
    list.push({
      handle_id: asNumber(row.handle_id) ?? 0,
      id: asString(row.id) ?? "",
      service: asString(row.service) ?? "",
      country: asString(row.country),
    });
    map.set(chatId, list);
  }
  return map;
}

/** Cheap identity: ROWID, guid, chat_identifier, handles. No COUNT(*) or last-message join. */
export function listChatIdentities(db: DatabaseSync): ChatIdentity[] {
  const tables = new Set(listTables(db));
  if (!tables.has("chat")) return [];
  const chatCols = tableColumns(db, "chat");
  const display = hasColumn(chatCols, "display_name") ? "c.display_name" : "NULL AS display_name";
  const identifier = hasColumn(chatCols, "chat_identifier")
    ? "c.chat_identifier"
    : "NULL AS chat_identifier";
  const service = hasColumn(chatCols, "service_name") ? "c.service_name" : "NULL AS service_name";
  const archived = hasColumn(chatCols, "is_archived") ? "c.is_archived" : "0 AS is_archived";
  const style = hasColumn(chatCols, "style") ? "c.style" : "NULL AS style";
  const rows = db
    .prepare(
      `SELECT c.ROWID AS chat_id, c.guid, ${identifier}, ${display}, ${service}, ${archived}, ${style}
       FROM chat c`,
    )
    .all() as Array<Record<string, unknown>>;
  const handles = loadAllHandlesByChat(db);
  return rows.map((row) => {
    const chatId = asNumber(row.chat_id) ?? 0;
    return {
      chat_id: chatId,
      guid: asString(row.guid) ?? "",
      chat_identifier: asString(row.chat_identifier),
      display_name: asString(row.display_name),
      service: asString(row.service_name),
      is_archived: (asNumber(row.is_archived) ?? 0) === 1,
      handles: handles.get(chatId) ?? [],
      style: asNumber(row.style),
    };
  });
}

function mapChat(
  db: DatabaseSync,
  row: Record<string, unknown>,
  redact: boolean,
  handles?: Handle[],
): ChatSummary {
  const chatId = asNumber(row.chat_id) ?? 0;
  const resolvedHandles = handles ?? loadHandlesForChat(db, chatId);
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
      handleCount: resolvedHandles.length,
    }),
    is_archived: (asNumber(row.is_archived) ?? 0) === 1,
    handles: resolvedHandles,
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
  opts: { limit?: number; query?: string; redact: boolean; chatIds?: number[] },
): ChatSummary[] {
  const tables = new Set(listTables(db));
  if (!tables.has("chat") || !tables.has("message") || !tables.has("chat_message_join")) {
    throw new MessagesError(
      "OPEN_FAILED",
      "chat.db is missing required tables (chat, message, chat_message_join).",
    );
  }

  const clauses: string[] = ["1=1"];
  const params: Array<string | number> = [];
  if (opts.chatIds && opts.chatIds.length > 0) {
    clauses.push(`c.ROWID IN (${opts.chatIds.map(() => "?").join(", ")})`);
    params.push(...opts.chatIds);
  } else if (opts.chatIds && opts.chatIds.length === 0) {
    return [];
  }

  const query = opts.query?.trim();
  if (query) {
    const like = `%${query.toLowerCase()}%`;
    clauses.push(`(
      LOWER(IFNULL(c.display_name, '')) LIKE ?
      OR LOWER(IFNULL(c.chat_identifier, '')) LIKE ?
      OR LOWER(IFNULL(c.guid, '')) LIKE ?
      OR EXISTS (
        SELECT 1 FROM chat_handle_join j
        JOIN handle h ON h.ROWID = j.handle_id
        WHERE j.chat_id = c.ROWID AND LOWER(h.id) LIKE ?
      )
    )`);
    params.push(like, like, like, like);
  }

  const sql = `${chatSelectSql(tableColumns(db, "chat"), tableColumns(db, "message"))}
    WHERE ${clauses.join(" AND ")}
    ORDER BY last_date DESC, c.ROWID DESC
    LIMIT ?`;
  params.push(clamp(opts.limit, DEFAULT_CHAT_LIMIT, MAX_CHAT_LIMIT));

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const chats = rows.map((row) => mapChat(db, row, opts.redact));
  if (!query) return chats;
  return chats.filter((chat) => {
    const q = query.toLowerCase();
    if (chat.display_name?.toLowerCase().includes(q)) return true;
    if (chat.chat_identifier?.toLowerCase().includes(q)) return true;
    if (chat.guid.toLowerCase().includes(q)) return true;
    return chat.handles.some(
      (handle) => handle.id.toLowerCase().includes(q) || handlesMatch(handle.id, query),
    );
  });
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

export function getChatByGuid(
  db: DatabaseSync,
  guid: string,
  redact: boolean,
): ChatSummary | null {
  const tables = new Set(listTables(db));
  if (!tables.has("chat")) return null;
  const sql = `${chatSelectSql(tableColumns(db, "chat"), tableColumns(db, "message"))}
    WHERE c.guid = ?
    LIMIT 1`;
  const row = db.prepare(sql).get(guid) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapChat(db, row, redact);
}

export function resolveScope(db: DatabaseSync, config: Config): ScopeMatch {
  const base = emptyScope(config);
  if (!base.active) {
    return { ...base, candidates: [] };
  }

  const tokens = collectScopeTokens(config);
  if (tokens.length === 0) {
    return {
      ...base,
      matched: false,
      candidates: listGroupNameCandidates(db),
    };
  }

  const identities = listChatIdentities(db);
  const matched: ChatIdentity[] = [];
  const seen = new Set<number>();
  const push = (identity: ChatIdentity | undefined): void => {
    if (!identity || seen.has(identity.chat_id)) return;
    seen.add(identity.chat_id);
    matched.push(identity);
  };

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      push(identities.find((chat) => chat.chat_id === Number(token)));
      continue;
    }
    if (looksLikeHandle(token)) {
      for (const identity of identities) {
        if (identity.handles.some((handle) => handlesMatch(handle.id, token))) {
          push(identity);
        }
      }
      continue;
    }
    for (const identity of identities) {
      if (chatMatchesToken(identity, token)) push(identity);
    }
  }

  const chats = matched.map(identityToSummary);
  const candidates = matched.length > 0 ? [] : listGroupNameCandidates(db);
  return {
    ...base,
    matched: matched.length > 0,
    chat: chats[0] ?? null,
    chats,
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
  if (chat.handles.some((handle) => tokens.some((token) => handlesMatch(handle.id, token)))) {
    return;
  }
  throw new MessagesError(
    "SCOPE",
    `Refusing chat_id ${chat.chat_id} (${chat.display_name ?? chat.chat_identifier ?? chat.guid}). This server is restricted to allowlist: ${tokens.join(", ") || "(empty)"}.`,
  );
}

function findChatsForHandle(db: DatabaseSync, handle: string, redact: boolean): ChatSummary[] {
  const tables = new Set(listTables(db));
  if (!tables.has("chat_handle_join") || !tables.has("handle")) return [];
  const rows = db
    .prepare(
      `SELECT j.chat_id AS chat_id, h.id AS id
       FROM chat_handle_join j
       JOIN handle h ON h.ROWID = j.handle_id`,
    )
    .all() as Array<Record<string, unknown>>;
  const chatIds = new Set<number>();
  for (const row of rows) {
    const id = asString(row.id) ?? "";
    const chatId = asNumber(row.chat_id);
    if (chatId !== null && handlesMatch(id, handle)) chatIds.add(chatId);
  }
  return [...chatIds]
    .map((chatId) => getChatById(db, chatId, redact))
    .filter((chat): chat is ChatSummary => chat !== null);
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
    const byGuid = getChatByGuid(db, args.handle, config.redactPreviews);
    if (byGuid) {
      assertChatAllowed(config, scope, byGuid);
      return { chat: byGuid, scope };
    }
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
    const rich = getChatById(db, scope.chat.chat_id, config.redactPreviews);
    return { chat: rich ?? scope.chat, scope };
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

function pushDateRange(
  clauses: string[],
  params: Array<string | number>,
  fromDate?: string,
  toDate?: string,
): void {
  if (fromDate) {
    if (!isIsoDate(fromDate)) {
      throw new MessagesError("INVALID_ARGS", "from_date must be an ISO-8601 timestamp.");
    }
    clauses.push("m.date >= ?");
    params.push(isoToAppleNanos(fromDate).toString());
  }
  if (toDate) {
    if (!isIsoDate(toDate)) {
      throw new MessagesError("INVALID_ARGS", "to_date must be an ISO-8601 timestamp.");
    }
    clauses.push("m.date <= ?");
    params.push(isoToAppleNanos(toDate).toString());
  }
}

export function getThread(
  db: DatabaseSync,
  opts: {
    chatId: number;
    limit?: number;
    before?: string | number;
    redact: boolean;
    includeReactions?: boolean;
    fromDate?: string;
    toDate?: string;
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
  pushDateRange(clauses, params, opts.fromDate, opts.toDate);

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
  if (/^\d+$/.test(ref)) {
    const chat = getChatById(db, Number(ref), config.redactPreviews);
    if (!chat) throw new MessagesError("NOT_FOUND", `No in-scope chat matches "${ref}".`);
    assertChatAllowed(config, scope, chat);
    return chat;
  }
  const byGuid = getChatByGuid(db, ref, config.redactPreviews);
  if (byGuid) {
    assertChatAllowed(config, scope, byGuid);
    return byGuid;
  }
  if (looksLikeHandle(ref)) {
    return resolveRequestedChat(db, config, { handle: ref }).chat;
  }
  const identities = listChatIdentities(db).filter((chat) => chatMatchesToken(chat, ref));
  const allowed = identities
    .map(identityToSummary)
    .filter((chat) => {
      try {
        assertChatAllowed(config, scope, chat);
        return true;
      } catch {
        return false;
      }
    });
  if (allowed.length === 0) {
    throw new MessagesError("NOT_FOUND", `No in-scope chat matches "${ref}".`);
  }
  if (allowed.length > 1) {
    throw new MessagesError(
      "INVALID_ARGS",
      `"${ref}" matches ${allowed.length} chats. Pass a chat_id or guid.`,
    );
  }
  return getChatById(db, allowed[0]!.chat_id, config.redactPreviews) ?? allowed[0]!;
}

function hasUndecodedEmptyText(
  db: DatabaseSync,
  baseClauses: string[],
  baseParams: Array<string | number>,
  knownIds: number[],
): boolean {
  const empty = "(m.text IS NULL OR trim(m.text) = '')";
  const rows = db
    .prepare(
      `SELECT m.ROWID AS message_id
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE ${baseClauses.join(" AND ")} AND ${empty}`,
    )
    .all(...baseParams) as Array<Record<string, unknown>>;
  if (knownIds.length === 0) return rows.length > 0;
  const known = new Set(knownIds);
  return rows.some((row) => {
    const id = asNumber(row.message_id);
    return id !== null && !known.has(id);
  });
}

function loadMessagesByIds(
  db: DatabaseSync,
  select: string,
  baseClauses: string[],
  baseParams: Array<string | number>,
  ids: number[],
  redact: boolean,
): MessageRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `${select}
       WHERE ${baseClauses.join(" AND ")}
         AND m.ROWID IN (${placeholders})`,
    )
    .all(...baseParams, ...ids) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const mapped = mapMessage(db, row, false);
    return { ...mapped, text: maybeRedact(mapped.text, redact) };
  });
}

export function searchMessages(
  db: DatabaseSync,
  opts: {
    query: string;
    chatId?: number;
    chatIds?: number[];
    limit?: number;
    redact: boolean;
    fromDate?: string;
    toDate?: string;
    sidecar?: DecodeSidecar;
  },
): SearchResult {
  const query = opts.query.trim();
  if (!query) {
    throw new MessagesError("INVALID_ARGS", "query must be a non-empty string.");
  }

  const sidecar = opts.sidecar;
  if (sidecar) {
    syncSidecarWithLiveMax(db, sidecar);
  }

  const messageCols = tableColumns(db, "message");
  const handleCols = tableColumns(db, "handle");
  const limit = clamp(opts.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const window = Math.max(limit * 20, TAHOE_SCAN_FLOOR);
  const needle = query.toLowerCase();
  const like = `%${needle}%`;

  const baseClauses = ["1=1"];
  const baseParams: Array<string | number> = [];
  if (opts.chatId !== undefined) {
    baseClauses.push("cmj.chat_id = ?");
    baseParams.push(opts.chatId);
  } else if (opts.chatIds && opts.chatIds.length > 0) {
    baseClauses.push(`cmj.chat_id IN (${opts.chatIds.map(() => "?").join(", ")})`);
    baseParams.push(...opts.chatIds);
  }
  if (hasColumn(messageCols, "associated_message_type")) {
    baseClauses.push("(m.associated_message_type IS NULL OR m.associated_message_type = 0)");
  }
  if (hasColumn(messageCols, "item_type")) {
    baseClauses.push("(m.item_type IS NULL OR m.item_type = 0)");
  }
  pushDateRange(baseClauses, baseParams, opts.fromDate, opts.toDate);

  const select = messageSelectSql(messageCols, handleCols);
  const byId = new Map<number, MessageRow>();

  const plainSql = `${select}
    WHERE ${baseClauses.join(" AND ")}
      AND m.text IS NOT NULL AND trim(m.text) != ''
      AND LOWER(m.text) LIKE ?
    ORDER BY m.date DESC, m.ROWID DESC
    LIMIT ${limit}`;
  const plainRows = db.prepare(plainSql).all(...baseParams, like) as Array<
    Record<string, unknown>
  >;
  for (const row of plainRows) {
    const mapped = mapMessage(db, row, false);
    byId.set(mapped.message_id, { ...mapped, text: maybeRedact(mapped.text, opts.redact) });
  }

  const tahoeSql = `${select}
    WHERE ${baseClauses.join(" AND ")}
      AND (m.text IS NULL OR trim(m.text) = '')
    ORDER BY m.date DESC, m.ROWID DESC
    LIMIT ${window}`;
  const tahoeRows = db.prepare(tahoeSql).all(...baseParams) as Array<
    Record<string, unknown>
  >;
  let scanned = 0;
  for (const row of tahoeRows) {
    scanned += 1;
    const mapped = mapMessage(db, row, false);
    if (sidecar) {
      sidecar.put(mapped.message_id, mapped.text);
    }
    if (mapped.text.toLowerCase().includes(needle) && !byId.has(mapped.message_id)) {
      byId.set(mapped.message_id, { ...mapped, text: maybeRedact(mapped.text, opts.redact) });
    }
  }

  if (sidecar) {
    const extraIds = sidecar
      .search(needle)
      .map((hit) => hit.message_id)
      .filter((id) => !byId.has(id));
    for (const mapped of loadMessagesByIds(
      db,
      select,
      baseClauses,
      baseParams,
      extraIds,
      opts.redact,
    )) {
      if (!byId.has(mapped.message_id)) {
        byId.set(mapped.message_id, mapped);
      }
    }
  }

  const messages = [...byId.values()]
    .sort((a, b) => {
      const at = a.sent_at ?? "";
      const bt = b.sent_at ?? "";
      if (at === bt) return b.message_id - a.message_id;
      return at < bt ? 1 : -1;
    })
    .slice(0, limit);

  const truncated = sidecar
    ? hasUndecodedEmptyText(db, baseClauses, baseParams, sidecar.messageIds())
    : tahoeRows.length >= window;

  return {
    messages,
    truncated,
    scanned,
  };
}

export type ChatWatermark = {
  chat_id: number;
  guid: string;
  chat_identifier: string | null;
  display_name: string | null;
  newest_message_id: number;
  newest_at: string | null;
};

/** Per-chat high-water marks. IDs only — no message text. */
export function getChatWatermarks(
  db: DatabaseSync,
  chatIds: number[] | null,
): ChatWatermark[] {
  const where =
    chatIds === null
      ? "1=1"
      : chatIds.length === 0
        ? "0"
        : `cmj.chat_id IN (${chatIds.map(() => "?").join(", ")})`;
  const params: number[] = chatIds ?? [];
  const rows = db
    .prepare(
      `SELECT
         cmj.chat_id AS chat_id,
         c.guid AS guid,
         c.chat_identifier AS chat_identifier,
         c.display_name AS display_name,
         CAST(MAX(m.ROWID) AS TEXT) AS newest_message_id,
         CAST(MAX(m.date) AS TEXT) AS newest_date
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE ${where}
       GROUP BY cmj.chat_id`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows
    .map((row) => ({
      chat_id: asNumber(row.chat_id) ?? 0,
      guid: asString(row.guid) ?? "",
      chat_identifier: asString(row.chat_identifier),
      display_name: asString(row.display_name),
      newest_message_id: asNumber(row.newest_message_id) ?? 0,
      newest_at: appleDateToIso(asAppleDate(row.newest_date)),
    }))
    .filter((row) => row.chat_id > 0 && row.newest_message_id > 0);
}

export function countMessagesAfterInChat(
  db: DatabaseSync,
  chatId: number,
  afterMessageId: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE cmj.chat_id = ? AND m.ROWID > ?`,
    )
    .get(chatId, afterMessageId) as Record<string, unknown> | undefined;
  return asNumber(row?.n) ?? 0;
}

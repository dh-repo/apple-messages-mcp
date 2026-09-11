export type ErrorCode =
  | "NOT_FOUND"
  | "PERMISSION"
  | "OPEN_FAILED"
  | "SCOPE"
  | "SEND_DISABLED"
  | "SEND_FAILED"
  | "INVALID_ARGS"
  | "UNSUPPORTED";

export class MessagesError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "MessagesError";
    this.code = code;
  }
}

export type DbMode = "copy" | "direct";

export type Config = {
  dbPath: string;
  dbMode: DbMode;
  enableSend: boolean;
  redactPreviews: boolean;
  scopeDisplayName: string | null;
  scopeChatId: number | null;
  /** Extra display names and/or chat.ROWID tokens from MESSAGES_SCOPE_ALLOWLIST. */
  scopeAllowlist: string[];
  /** When true, ignore any scope env and expose every readable chat. */
  allowUnscoped: boolean;
};

export type Handle = {
  handle_id: number;
  id: string;
  service: string;
  country: string | null;
};

export type ChatSummary = {
  chat_id: number;
  guid: string;
  chat_identifier: string | null;
  display_name: string | null;
  service: string | null;
  is_group: boolean;
  is_archived: boolean;
  handles: Handle[];
  last_message_at: string | null;
  last_preview: string | null;
  message_count: number;
};

export type AttachmentMeta = {
  attachment_id: number;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
  total_bytes: number | null;
};

export type TextSource = "text" | "attributedBody" | "none";

export type MessageRow = {
  message_id: number;
  chat_id: number;
  guid: string | null;
  from_me: boolean;
  handle_id: number | null;
  handle: string | null;
  text: string;
  text_source: TextSource;
  sent_at: string | null;
  service: string | null;
  has_attachments: boolean;
  attachments: AttachmentMeta[];
};

export type ScopeMatch = {
  active: boolean;
  mode: "unscoped" | "allowlist";
  note: string;
  configured_name: string | null;
  configured_chat_id: number | null;
  allowlist: string[];
  matched: boolean;
  /** First allowlist match; null when unscoped or nothing matched. */
  chat: ChatSummary | null;
  chats: ChatSummary[];
  /** Group chats (display_name set) when an allowlist was set but nothing matched. */
  candidates: Array<{ chat_id: number; display_name: string }>;
};

export type StatusReport = {
  ok: boolean;
  readable: boolean;
  db_path: string;
  db_exists: boolean;
  db_mode: DbMode;
  opened_via: DbMode | null;
  fda_likely_missing: boolean;
  error: { code: ErrorCode; message: string } | null;
  platform: NodeJS.Platform;
  macos: { product: string; version: string; build: string } | null;
  send_enabled: boolean;
  redact_previews: boolean;
  allow_unscoped: boolean;
  unscoped: boolean;
  scope: ScopeMatch;
  schema: {
    tables: string[];
    has_attributed_body: boolean;
    has_chat_message_join: boolean;
  } | null;
};

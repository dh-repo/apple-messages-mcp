import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeAttributedBody } from "../../src/decode/attributedBody.ts";
import { isoToAppleNanos } from "../../src/db/dates.ts";
import type { Config } from "../../src/types.ts";

/** Generic fixture group title — not a product default. */
export const GROUP_NAME = "Weekend Plans";
export const DECOY_HANDLE = "+15550009999";

export type FixtureIds = {
  groupChatId: number;
  decoyChatId: number;
  groupMessageIds: number[];
  decoyMessageId: number;
  attachmentMessageId: number;
};

export function makeConfig(overrides: Partial<Config> & { dbPath: string }): Config {
  return {
    dbMode: "direct",
    enableSend: false,
    redactPreviews: false,
    scopeDisplayName: null,
    scopeChatId: null,
    scopeAllowlist: [],
    allowUnscoped: false,
    ...overrides,
  };
}

/** Optional allowlist pinned to the fixture group. */
export function makeScopedConfig(overrides: Partial<Config> & { dbPath: string }): Config {
  return makeConfig({
    scopeDisplayName: GROUP_NAME,
    ...overrides,
  });
}

export function createFixtureDb(dir?: string): { path: string; ids: FixtureIds; cleanup: () => void } {
  const root = dir ?? mkdtempSync(join(tmpdir(), "apple-messages-fixture-"));
  mkdirSync(root, { recursive: true });
  const path = join(root, "chat.db");
  const db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE,
      id TEXT NOT NULL,
      country TEXT,
      service TEXT NOT NULL,
      uncanonicalized_id TEXT,
      UNIQUE (id, service)
    );
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      style INTEGER,
      state INTEGER,
      chat_identifier TEXT,
      service_name TEXT,
      display_name TEXT,
      group_id TEXT,
      is_archived INTEGER DEFAULT 0
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER,
      date INTEGER,
      is_from_me INTEGER,
      cache_has_attachments INTEGER DEFAULT 0,
      service TEXT,
      associated_message_type INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0
    );
    CREATE TABLE chat_message_join (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      message_date INTEGER,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE chat_handle_join (
      chat_id INTEGER NOT NULL,
      handle_id INTEGER NOT NULL,
      UNIQUE (chat_id, handle_id)
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      filename TEXT,
      uti TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER DEFAULT 0,
      created_date INTEGER DEFAULT 0
    );
    CREATE TABLE message_attachment_join (
      message_id INTEGER NOT NULL,
      attachment_id INTEGER NOT NULL
    );
  `);

  const insertHandle = db.prepare(
    `INSERT INTO handle (id, country, service) VALUES (?, 'us', ?)`,
  );
  const handles = [
    { id: "+15551001001", service: "iMessage" },
    { id: "+15551001002", service: "iMessage" },
    { id: "+15551001003", service: "iMessage" },
    { id: "+15551001004", service: "iMessage" },
    { id: "+15551001005", service: "iMessage" },
    { id: "brian@example.com", service: "iMessage" },
    { id: "lynn@example.com", service: "iMessage" },
    { id: DECOY_HANDLE, service: "SMS" },
  ];
  const handleIds = handles.map((h) => Number(insertHandle.run(h.id, h.service).lastInsertRowid));

  const groupChatId = Number(
    db
      .prepare(
        `INSERT INTO chat (guid, style, state, chat_identifier, service_name, display_name, group_id)
         VALUES ('iMessage;+;chat111', 43, 3, 'chat111', 'iMessage', ?, 'group-111')`,
      )
      .run(GROUP_NAME).lastInsertRowid,
  );
  const decoyChatId = Number(
    db
      .prepare(
        `INSERT INTO chat (guid, style, state, chat_identifier, service_name, display_name)
         VALUES ('SMS;-;${DECOY_HANDLE}', 45, 3, '${DECOY_HANDLE}', 'SMS', NULL)`,
      )
      .run().lastInsertRowid,
  );

  const joinHandle = db.prepare(
    `INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)`,
  );
  for (const hid of handleIds.slice(0, 7)) {
    joinHandle.run(groupChatId, hid);
  }
  const decoyHandleId = handleIds[7];
  if (decoyHandleId === undefined) {
    throw new Error("fixture: missing decoy handle");
  }
  joinHandle.run(decoyChatId, decoyHandleId);

  const insertMessage = db.prepare(
    `INSERT INTO message (guid, text, attributedBody, handle_id, date, is_from_me, cache_has_attachments, service, associated_message_type, item_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const joinMessage = db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  );

  const add = (args: {
    guid: string;
    text: string | null;
    body?: Buffer | null;
    handleId: number | null;
    iso: string;
    fromMe: number;
    chatId: number;
    attachments?: number;
    assoc?: number;
    service?: string;
  }): number => {
    const date = isoToAppleNanos(args.iso).toString();
    const id = Number(
      insertMessage.run(
        args.guid,
        args.text,
        args.body ?? null,
        args.handleId,
        date,
        args.fromMe,
        args.attachments ?? 0,
        args.service ?? "iMessage",
        args.assoc ?? 0,
        0,
      ).lastInsertRowid,
    );
    joinMessage.run(args.chatId, id, date);
    return id;
  };

  const m1 = add({
    guid: "msg-1",
    text: "Who is bringing the snacks?",
    handleId: handleIds[0] ?? null,
    iso: "2026-03-01T18:00:00Z",
    fromMe: 0,
    chatId: groupChatId,
  });
  const m2 = add({
    guid: "msg-2",
    text: "I can do chips.",
    handleId: handleIds[1] ?? null,
    iso: "2026-03-01T18:01:00Z",
    fromMe: 0,
    chatId: groupChatId,
  });
  const m3 = add({
    guid: "msg-3",
    text: null,
    body: encodeAttributedBody("Tahoe-only body: meet at 7."),
    handleId: handleIds[2] ?? null,
    iso: "2026-03-01T18:02:00Z",
    fromMe: 0,
    chatId: groupChatId,
  });
  const m4 = add({
    guid: "msg-4",
    text: "See you there.",
    handleId: null,
    iso: "2026-03-01T18:03:00Z",
    fromMe: 1,
    chatId: groupChatId,
    attachments: 1,
  });
  const reaction = add({
    guid: "msg-tapback",
    text: "Loved “See you there.”",
    handleId: handleIds[3] ?? null,
    iso: "2026-03-01T18:03:30Z",
    fromMe: 0,
    chatId: groupChatId,
    assoc: 2000,
  });
  const decoyMessageId = add({
    guid: "msg-decoy",
    text: "SECRET decoy thread about taxes",
    handleId: handleIds[7] ?? null,
    iso: "2026-03-02T12:00:00Z",
    fromMe: 0,
    chatId: decoyChatId,
    service: "SMS",
  });

  const attachmentId = Number(
    db
      .prepare(
        `INSERT INTO attachment (guid, filename, mime_type, transfer_name, total_bytes)
         VALUES ('att-1', '~/Library/Messages/Attachments/xx/photo.jpg', 'image/jpeg', 'photo.jpg', 2048)`,
      )
      .run().lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)`,
  ).run(m4, attachmentId);

  db.close();

  return {
    path,
    ids: {
      groupChatId,
      decoyChatId,
      groupMessageIds: [m1, m2, m3, m4, reaction],
      decoyMessageId,
      attachmentMessageId: m4,
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

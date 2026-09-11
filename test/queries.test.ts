import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  assertChatAllowed,
  getThread,
  listChats,
  resolveRequestedChat,
  resolveScope,
  searchMessages,
} from "../src/db/queries.ts";
import { MessagesError } from "../src/types.ts";
import {
  createFixtureDb,
  DECOY_HANDLE,
  GROUP_NAME,
  makeConfig,
  makeScopedConfig,
} from "./helpers/fixture.ts";

const fixtures: Array<{ cleanup: () => void }> = [];

function openFixture() {
  const created = createFixtureDb();
  fixtures.push(created);
  const db = new DatabaseSync(created.path, { readOnly: true });
  return { db, ids: created.ids, path: created.path };
}

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("scoped queries", () => {
  it("lists both chats when unscoped", () => {
    const { db } = openFixture();
    const chats = listChats(db, { redact: false });
    expect(chats.map((c) => c.display_name)).toContain(GROUP_NAME);
    expect(chats.some((c) => c.handles.some((h) => h.id === DECOY_HANDLE))).toBe(true);
    db.close();
  });

  it("is unscoped when no MESSAGES_SCOPE_* is set", () => {
    const { db } = openFixture();
    const scope = resolveScope(db, makeConfig({ dbPath: ":memory:" }));
    expect(scope.active).toBe(false);
    expect(scope.mode).toBe("unscoped");
    expect(scope.note).toMatch(/All readable chats are available/);
    expect(scope.matched).toBe(true);
    db.close();
  });

  it("resolves an optional display-name allowlist", () => {
    const { db, ids } = openFixture();
    const scope = resolveScope(db, makeScopedConfig({ dbPath: ":memory:" }));
    expect(scope.active).toBe(true);
    expect(scope.matched).toBe(true);
    expect(scope.chat?.chat_id).toBe(ids.groupChatId);
    expect(scope.chat?.is_group).toBe(true);
    expect(scope.chat?.handles).toHaveLength(7);
    db.close();
  });

  it("resolves MESSAGES_SCOPE_ALLOWLIST tokens", () => {
    const { db, ids } = openFixture();
    const scope = resolveScope(
      db,
      makeConfig({ dbPath: ":memory:", scopeAllowlist: [String(ids.groupChatId)] }),
    );
    expect(scope.chats.map((c) => c.chat_id)).toEqual([ids.groupChatId]);
    db.close();
  });

  it("refuses the decoy chat while scoped", () => {
    const { db, ids } = openFixture();
    const config = makeScopedConfig({ dbPath: ":memory:" });
    const scope = resolveScope(db, config);
    const decoy = listChats(db, { redact: false }).find((c) => c.chat_id === ids.decoyChatId);
    expect(decoy).toBeTruthy();
    expect(() => assertChatAllowed(config, scope, decoy!)).toThrow(MessagesError);
    db.close();
  });

  it("returns group messages including attributedBody fallback, excluding tapbacks", () => {
    const { db, ids } = openFixture();
    const messages = getThread(db, { chatId: ids.groupChatId, redact: false });
    const texts = messages.map((m) => m.text);
    expect(texts).toContain("Who is bringing the snacks?");
    expect(texts).toContain("Tahoe-only body: meet at 7.");
    expect(texts.some((t) => t.includes("Loved"))).toBe(false);
    const attributed = messages.find((m) => m.text_source === "attributedBody");
    expect(attributed?.text).toBe("Tahoe-only body: meet at 7.");
    const withAtt = messages.find((m) => m.message_id === ids.attachmentMessageId);
    expect(withAtt?.attachments[0]?.transfer_name).toBe("photo.jpg");
    expect(withAtt?.attachments[0]?.mime_type).toBe("image/jpeg");
    db.close();
  });

  it("paginates with before=message_id", () => {
    const { db, ids } = openFixture();
    const page = getThread(db, {
      chatId: ids.groupChatId,
      limit: 1,
      before: ids.attachmentMessageId,
      redact: false,
    });
    expect(page).toHaveLength(1);
    expect(page[0]?.text).toBe("Tahoe-only body: meet at 7.");
    db.close();
  });

  it("searches attributedBody text inside one chat when chatId is passed", () => {
    const { db, ids } = openFixture();
    const hits = searchMessages(db, {
      query: "Tahoe-only",
      chatId: ids.groupChatId,
      redact: false,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain("meet at 7");

    const decoyHits = searchMessages(db, {
      query: "SECRET",
      chatId: ids.groupChatId,
      redact: false,
    });
    expect(decoyHits).toHaveLength(0);

    const across = searchMessages(db, { query: "SECRET", redact: false });
    expect(across.some((m) => m.text.includes("SECRET"))).toBe(true);
    db.close();
  });

  it("redacts previews without dropping metadata", () => {
    const { db, ids } = openFixture();
    const chats = listChats(db, { redact: true });
    const group = chats.find((c) => c.chat_id === ids.groupChatId);
    expect(group?.last_preview).toMatch(/^\[redacted \d+ chars\]$/);
    const messages = getThread(db, { chatId: ids.groupChatId, redact: true });
    expect(messages.every((m) => m.text.startsWith("[redacted") || m.text === "")).toBe(
      true,
    );
    expect(messages[0]?.message_id).toBeTypeOf("number");
    db.close();
  });

  it("get_thread without args uses a single-chat allowlist", () => {
    const { db, ids } = openFixture();
    const { chat } = resolveRequestedChat(db, makeScopedConfig({ dbPath: ":memory:" }), {});
    expect(chat.chat_id).toBe(ids.groupChatId);
    db.close();
  });

  it("get_thread without args refuses to guess when unscoped", () => {
    const { db } = openFixture();
    expect(() =>
      resolveRequestedChat(db, makeConfig({ dbPath: ":memory:" }), {}),
    ).toThrow(/unscoped/);
    db.close();
  });

  it("matches a participant handle with extra punctuation", () => {
    const { db, ids } = openFixture();
    const { chat } = resolveRequestedChat(db, makeConfig({ dbPath: ":memory:" }), {
      handle: "+1 (555) 100-1001",
    });
    expect(chat.chat_id).toBe(ids.groupChatId);
    db.close();
  });

  it("filters list_chats by query", () => {
    const { db } = openFixture();
    const hits = listChats(db, { query: "weekend", redact: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.display_name).toBe(GROUP_NAME);
    db.close();
  });
});

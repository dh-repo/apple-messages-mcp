import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import {
  createFixtureDb,
  GROUP_NAME,
  makeConfig,
  makeUnscopedConfig,
} from "./helpers/fixture.ts";

const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function parseContent(result: unknown): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const block = content?.[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block?.text ?? "{}");
}

describe("MCP protocol", () => {
  it("omits messages_send when ENABLE_SEND is off", async () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const server = createServer(makeConfig({ dbPath: fixture.path }));
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => {
      void client.close();
      void server.close();
    });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "messages_get_thread",
      "messages_list_chats",
      "messages_search",
      "messages_status",
    ]);
  });

  it("returns SCOPE from list when no env opens the inbox", async () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const server = createServer(makeConfig({ dbPath: fixture.path }));
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => {
      void client.close();
      void server.close();
    });

    const status = parseContent(
      await client.callTool({ name: "messages_status", arguments: {} }),
    ) as { unscoped: boolean };
    expect(status.unscoped).toBe(false);

    const listed = parseContent(
      await client.callTool({ name: "messages_list_chats", arguments: {} }),
    ) as { error?: { code: string }; scope?: { candidates: Array<{ display_name: string }> } };
    expect(listed.error?.code).toBe("SCOPE");
  });

  it("lists chats when unscoped and requires confirm on send", async () => {
    const fixture = createFixtureDb();
    cleanups.push(fixture.cleanup);
    const server = createServer(
      makeUnscopedConfig({ dbPath: fixture.path, enableSend: true }),
    );
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => {
      void client.close();
      void server.close();
    });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("messages_send");

    const chats = parseContent(
      await client.callTool({ name: "messages_list_chats", arguments: {} }),
    ) as { chats: Array<{ chat_id: number; display_name: string | null; guid: string }> };
    expect(chats.chats.length).toBeGreaterThanOrEqual(2);
    const group = chats.chats.find((c) => c.display_name === GROUP_NAME);
    expect(group?.guid).toBeTruthy();

    const thread = parseContent(
      await client.callTool({
        name: "messages_get_thread",
        arguments: { chat_id: group!.chat_id, limit: 10 },
      }),
    ) as { messages: Array<{ text: string; text_source: string }>; chat: { guid: string } };
    expect(thread.chat.guid).toBe(group!.guid);
    expect(thread.messages.some((m) => m.text_source === "attributedBody")).toBe(true);

    const search = parseContent(
      await client.callTool({
        name: "messages_search",
        arguments: { query: "snacks" },
      }),
    ) as { messages: Array<{ text: string }>; truncated: boolean };
    expect(search.messages).toHaveLength(1);
    expect(search.truncated).toBeTypeOf("boolean");

    const send = parseContent(
      await client.callTool({
        name: "messages_send",
        arguments: { to: GROUP_NAME, body: "hi" },
      }),
    ) as { error?: { code: string } };
    expect(send.error?.code).toBe("INVALID_ARGS");

    const preview = parseContent(
      await client.callTool({
        name: "messages_send",
        arguments: { to: GROUP_NAME, body: "hi", dry_run: true },
      }),
    ) as { to: string; chat_id: number; guid: string; body: string; via?: string };
    expect(preview).toEqual({
      to: GROUP_NAME,
      chat_id: group!.chat_id,
      guid: group!.guid,
      body: "hi",
    });
    expect(preview.via).toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { createFixtureDb, GROUP_NAME, makeConfig } from "./helpers/fixture.ts";

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
  it("lists Phase 1 tools and serves all chats when unscoped", async () => {
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
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "messages_get_thread",
      "messages_list_chats",
      "messages_search",
      "messages_send",
      "messages_status",
    ]);

    const status = parseContent(
      await client.callTool({ name: "messages_status", arguments: {} }),
    ) as {
      ok: boolean;
      unscoped: boolean;
      scope: { active: boolean; mode: string; note: string };
    };
    expect(status.ok).toBe(true);
    expect(status.unscoped).toBe(true);
    expect(status.scope.active).toBe(false);
    expect(status.scope.mode).toBe("unscoped");
    expect(status.scope.note).toMatch(/All readable chats are available/);

    const chats = parseContent(
      await client.callTool({ name: "messages_list_chats", arguments: {} }),
    ) as { chats: Array<{ chat_id: number; display_name: string | null }> };
    expect(chats.chats.length).toBeGreaterThanOrEqual(2);
    const group = chats.chats.find((c) => c.display_name === GROUP_NAME);
    expect(group).toBeTruthy();

    const thread = parseContent(
      await client.callTool({
        name: "messages_get_thread",
        arguments: { chat_id: group!.chat_id, limit: 10 },
      }),
    ) as { messages: Array<{ text: string; text_source: string }> };
    expect(thread.messages.some((m) => m.text_source === "attributedBody")).toBe(true);
    expect(thread.messages.some((m) => m.text.includes("Tahoe-only"))).toBe(true);

    const search = parseContent(
      await client.callTool({
        name: "messages_search",
        arguments: { query: "snacks" },
      }),
    ) as { messages: Array<{ text: string }> };
    expect(search.messages).toHaveLength(1);

    const send = parseContent(
      await client.callTool({
        name: "messages_send",
        arguments: { to: GROUP_NAME, body: "hi" },
      }),
    ) as { error?: { code: string } };
    expect(send.error?.code).toBe("SEND_DISABLED");
  });
});

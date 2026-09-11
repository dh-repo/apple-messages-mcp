# apple-messages-mcp

Local MCP server that lets a Cursor or Grok Bot agent read **your** Messages.app database on the user's Mac (iMessage + SMS), and optionally send a reply through AppleScript.

There is no cloud inbox and no extra phone number. Reads stay on localhost. **Read-only by default.** **Scoped shut by default.** With no `MESSAGES_SCOPE` and no `MESSAGES_ALLOW_UNSCOPED=1`, list/search/thread/send/watch return `SCOPE`. A personal bot that wants the whole inbox sets one line: `MESSAGES_ALLOW_UNSCOPED=1`.

See [DESIGN.md](./DESIGN.md) for schema notes, the threat model, Phase 2 watcher hook, and agent instructions.

## Requirements

- macOS with Messages.app (the live `chat.db` path)
- Node.js 22+
- Full Disk Access for the app that launches this server (Cursor, or Terminal if you test from a shell)
- Automation permission for Messages only if you turn send on

Linux CI uses a tiny fixture SQLite database. You do not need Messages.app to run `npm test`.

## Install

```bash
git clone https://github.com/dh-repo/apple-messages-mcp.git
cd apple-messages-mcp
npm install
npm test
```

The server speaks MCP over stdio (leave this to Cursor; do not write logs to stdout):

```bash
npm run build
node dist/index.js
```

Dev: `npx tsx src/index.ts`. Same binary is a local CLI for the smoke checklist and the Phase 2 watcher:

```bash
npx tsx src/index.ts status
npx tsx src/index.ts list
npx tsx src/index.ts thread --chat-id 12 --limit 20
npx tsx src/index.ts search snacks
npx tsx src/index.ts watch --interval 3000
```

## Full Disk Access

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Enable **Cursor** (and **Terminal** if you smoke-test here).
3. Quit and reopen that app. TCC is applied at launch.
4. If `messages_status` returns `fda_likely_missing: true` or `PERMISSION`, this step is not done.

Without FDA, macOS returns `EPERM` for `~/Library/Messages/chat.db` even to the file's owner.

## Cursor / Claude Desktop config

Cursor **Add MCP server** / `mcp.json` (same shape):

```json
{
  "mcpServers": {
    "apple-messages": {
      "command": "node",
      "args": ["/ABS/PATH/TO/apple-messages-mcp/dist/index.js"],
      "env": {
        "MESSAGES_DB_MODE": "copy",
        "ENABLE_SEND": "0",
        "REDACT_PREVIEWS": "0"
      }
    }
  }
}
```

A checked-in copy lives at [examples/cursor-mcp.json](./examples/cursor-mcp.json). Point `args` at your clone.

Claude Desktop: paste the same `mcpServers` block into `claude_desktop_config.json`.

Dev without a build: `npx tsx src/index.ts`.

### Environment

Default is scoped shut. Pick one:

```json
"MESSAGES_SCOPE": "Family, 12"
```

```json
"MESSAGES_ALLOW_UNSCOPED": "1"
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MESSAGES_SCOPE` | unset | Comma/semicolon tokens: display name, `chat_id`, `guid`, handle. |
| `MESSAGES_ALLOW_UNSCOPED` | `0` | `1` is the only way to open the whole inbox. |
| `MESSAGES_DB_PATH` | `~/Library/Messages/chat.db` | Override for fixtures. |
| `MESSAGES_DB_MODE` | `copy` | Copy + WAL replay. `direct` opens the live file. |
| `ENABLE_SEND` | `0` | `1` enables `messages_send` (real texts). |
| `REDACT_PREVIEWS` | `0` | Bodies become `[redacted N chars]`. |
| `MESSAGES_WAKE_HOOK` | unset | Watcher runs this executable with one JSON event on stdin. |
| `WATCH_INCLUDE_PREVIEW` | `0` | Watcher includes a **redacted** preview. |

## Tools

| Tool | What it does |
| --- | --- |
| `messages_status` | Can we read `chat.db`? FDA missing? Scoped shut or unscoped? Snapshot size/age? |
| `messages_list_chats` | Recent chats, or only the allowlist if one is set. |
| `messages_get_thread` | Messages for a `chat_id` / guid / handle (required unless the allowlist is exactly one chat). |
| `messages_search` | Two-phase substring search (plain `text` LIKE, then a bounded Tahoe decode). Returns `truncated`. |
| `messages_send` | Registered only when `ENABLE_SEND=1`. Requires `confirm: true`. |

IDs in responses are SQLite `ROWID`s: `chat_id`, `message_id`, `handle_id`, `attachment_id`. Handles are phone numbers and emails, not Contacts names.

Copy this into the agent's MCP instructions: the block in [DESIGN.md §8](./DESIGN.md#8-what-grok-bot--cursor-agents-should-set-as-mcp-instructions).

## Watcher (Phase 2)

Not push, and not part of the MCP stdio stream. A second process polls `chat.db` (and optionally `fs.watch`s the WAL) for new ROWIDs — all chats, or only the allowlist if one is set — then writes JSON lines:

```bash
npx tsx src/index.ts watch --interval 3000
# {"type":"messages.ready","chat_id":…,"newest_message_id":…}
# {"type":"messages.new","chat_id":…,"count_new":1,"preview":null}
```

Pipe that into your own wake script, or set `MESSAGES_WAKE_HOOK` to [examples/wake-hook.sh](./examples/wake-hook.sh). The host should start an agent turn and call `messages_get_thread`. Do not treat this as a Slack-style channel.

## Smoke-test checklist (Mac)

1. `npm test` passes (fixture-only; safe on any machine).
2. Grant FDA, restart Cursor, reload the MCP server.
3. Call `messages_status`.
   - `readable: true`
   - `fda_likely_missing: false`
   - `unscoped: false` unless you set `MESSAGES_ALLOW_UNSCOPED=1`
   - Optional: set `MESSAGES_SCOPE` and confirm `scope.active: true` and `scope.chats` matches
4. `messages_list_chats` without scope env returns `SCOPE` and `scope.candidates`.
5. `messages_get_thread` with a `chat_id` from a scoped or unscoped list returns recent lines. At least some `text_source` values may be `attributedBody` on current macOS. `text_source: "guess"` means the decoder fell back to printable bytes.
6. `messages_search` with a word you know exists returns hits across chats, or empty + `truncated: true` when the Tahoe window missed.
7. `messages_send` is absent from `tools/list` while `ENABLE_SEND` is unset.
8. Optional: `ENABLE_SEND=1`, Automation allowed, send a one-line test, confirm it in Messages.app. Leave send off afterward.
9. `npx tsx src/index.ts status` (CLI) matches the MCP `messages_status` payload.
10. `npx tsx src/index.ts watch --interval 2000` prints one `messages.ready` line and, on a new message, `messages.new` without plaintext.

Inspector, if you want a GUI without Cursor:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

## What this is not

- Not Inkbox / Linq / a hosted agent number.
- Not a push notification service. The Phase 2 `watch` process polls / `fs.watch`s `chat.db` and wakes the host — see DESIGN.md.
- Not a way to dump `chat.db` to a server.

## License

MIT. See [LICENSE](./LICENSE).

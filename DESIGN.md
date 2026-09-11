# Apple Messages MCP — design

Local, read-mostly connector so a Cursor / Grok Bot agent can use **the user's real Messages.app data** on their Mac. No marketplace phone number. No cloud relay. The process reads `chat.db` on localhost and, only when explicitly enabled, asks Messages.app to send via AppleScript.

**Default scope:** shut. If the host does not set `MESSAGES_SCOPE` and does not set `MESSAGES_ALLOW_UNSCOPED=1`, `list` / `search` / `get_thread` / `send` / `watch` return `SCOPE` and `scope.candidates` (group titles only). `messages_status.unscoped` is true only with the explicit flag. An allowlist filters *results*, not the bytes of the temp copy.

Contacts names visible in Messages live in AddressBook, **not** in `chat.db`. Phase 1 returns phone/email handles and `chat.display_name` when Apple stored one. We do not open Contacts.

---

## 1. Architecture

```
Cursor / Claude Desktop / Grok Bot
        │  stdio JSON-RPC (MCP)
        ▼
apple-messages-mcp (this repo, Node 22+)
        │
        ├─ warm snapshot ─► one 0700 chat.db + WAL/SHM copy per process
        │                    recopy on live db/wal mtime/size change
        │                    (list / thread / search / watch share it)
        ├─ optional ─► osascript ─► Messages.app  (send only)
        └─ optional ─► `watch` process ─► JSON line / MESSAGES_WAKE_HOOK
```

- Transport: stdio. stdout is the protocol; logs go to stderr and never include message bodies.
- No HTTP server. No remote sync. No private Messages APIs. No GUI scrape. SIP stays on.
- Default query engine is Node's built-in `node:sqlite` (`DatabaseSync`). That is a real SQLite, so a copied `chat.db` + `-wal` + `-shm` can replay the WAL. `sql.js` cannot apply WAL from a byte buffer, which would drop the newest messages while Messages.app is open. `better-sqlite3` would also work; we avoided a native addon because tests must run on a Linux CI VM.

### Warm snapshot (default `MESSAGES_DB_MODE=copy`)

1. `access()` the live file. `EACCES` / `EPERM` → treat as **Full Disk Access missing**.
2. Keep **one** `0700` directory under `$TMPDIR` per process. Recopy only when live `chat.db` or `-wal` mtime/size changes.
3. Copy order is best-effort against a writer: `-wal`, `chat.db`, `-wal` again, `-shm`. Then `PRAGMA integrity_check`. Retry a few times. This is still a race, not snapshot isolation.
4. Open the copy so SQLite can apply the WAL, then `PRAGMA query_only=ON`. The watcher shares this snapshot.
5. Unlink the directory on process exit / SIGTERM. Do not photocopy on every tool call.

`MESSAGES_DB_MODE=direct` opens the live file read-only. Do not switch the default to `direct`; Messages.app often holds a write lock and the snapshot can be stale.

**Honest limitation:** the temp copy is the *entire* database. An allowlist filters *results*, not the bytes on disk. `messages_status` reports `temp_copy_bytes` and `snapshot_age_ms`.

---

## 2. Data sources

### 2.1 `~/Library/Messages/chat.db` (Phase 1 reads)

SQLite. Path override: `MESSAGES_DB_PATH`. Schema drifts across macOS releases; code uses `PRAGMA table_info` and treats missing columns as null. The following is what current (Sonoma / Sequoia / Tahoe) databases actually look like, verified against public dumps and write-ups — not an Apple-supported API.

| Table | Role |
| --- | --- |
| `chat` | One row per thread. `ROWID` is our `chat_id`. `guid` like `iMessage;+;chat…` (group) or `iMessage;-;+1…` (1:1). `display_name` is the group title (often null on 1:1). `chat_identifier` is a phone, email, or `chat…` token. `service_name` is `iMessage` or `SMS`. `style` 43 ≈ group, 45 ≈ 1:1. |
| `handle` | Participant identifiers. `id` is phone or email. **No person name.** `service` + `id` are unique. |
| `chat_handle_join` | `chat_id` ↔ `handle_id`. |
| `message` | One row per message **and** each tapback. `ROWID` is our `message_id`. `text` may be NULL. `attributedBody` is an NSArchiver typedstream blob. `date` is nanoseconds (sometimes seconds on old rows) since 2001-01-01 UTC. `is_from_me`, `handle_id`, `service`, `cache_has_attachments`, `associated_message_type`, `item_type`. |
| `chat_message_join` | `chat_id` ↔ `message_id` (+ denormalized `message_date`). |
| `attachment` | Metadata only for Phase 1: `filename`, `mime_type`, `transfer_name`, `total_bytes`. Files sit under `~/Library/Messages/Attachments/`. |
| `message_attachment_join` | `message_id` ↔ `attachment_id`. |

**Text on modern macOS.** From about Sonoma onward, and almost always on Tahoe (macOS 26), `message.text` is empty and the body is only in `attributedBody`. We decode the first `NSString` payload after the `NSString` marker and `0x2B` length prefix. If that fails and we fall back to printable bytes, `text_source` is `"guess"` so class-name junk is not silently “the body.” If both columns are empty, the row is attachment-only or a tapback.

**Dates.** `datetime(date/1000000000 + 978307200, 'unixepoch')`. We also accept legacy second-resolution values by magnitude. Nanosecond values (~1e18) do not fit in a JavaScript number; every `date` column is `CAST(... AS TEXT)` and parsed as `BigInt`.

**Tapbacks.** `associated_message_type` 2000–2005 are Loved / Liked / …; 3000–3005 remove them. Phase 1 hides these unless `include_reactions=true`.

**Identifiers we expose**

| Field | Source |
| --- | --- |
| `chat_id` | `chat.ROWID` |
| `guid` | `chat.guid` |
| `handle_id` | `handle.ROWID` |
| `handle` / `id` | `handle.id` (phone or email) |
| `message_id` | `message.ROWID` |
| `attachment_id` | `attachment.ROWID` |

### 2.2 AppleScript send path (optional)

Only when `ENABLE_SEND=1`. No private send API, no SIP off.

```
osascript  →  Messages.app  →  iMessage / SMS
```

- Group: `send theBody to chat theTarget` where `theTarget` is the chat display name.
- 1:1: `participant` of the first iMessage account.

Arguments are passed as `argv` to `osascript` (no string interpolation into the script). The launching app needs **Automation** permission for Messages. Delivery is Apple's problem; we only report that `osascript` exited 0.

---

## 3. Threat model

| Asset | Risk | Mitigation |
| --- | --- | --- |
| Entire `chat.db` | FDA + this process = every thread | Default scoped shut; `MESSAGES_ALLOW_UNSCOPED=1` is the only whole-inbox switch; do not add AddressBook |
| Temp copy | Full DB bytes in `$TMPDIR` for the process lifetime | One `0700` snapshot; recopy on wal/db change; unlink on exit; never upload |
| Tool results | The MCP host (Cursor, Grok Bot) sees plaintext | Trust the host; optional `REDACT_PREVIEWS=1`; instructions say do not ship bodies off-box |
| Logs | Accidental cloud log of SMS/iMessage | stderr events are counts / ids / error codes only |
| Send | Agent sends a real text | Tool unregistered unless `ENABLE_SEND=1`; then `confirm: true` is required |
| Network | None in Phase 1 | No telemetry, no HTTP |
| TCC bypass | Tempting to attach to Messages or disable SIP | Out of scope. We fail closed and explain FDA / Automation |

We do **not** claim end-to-end encryption toward the model. If the host sends tool output to a remote LLM, that is the user's host policy, not this connector.

---

## 4. TCC / Full Disk Access

`~/Library/Messages` is TCC-protected. Without FDA, `open()` returns `EPERM` and `messages_status` sets `fda_likely_missing: true`.

1. System Settings → Privacy & Security → Full Disk Access.
2. Enable the app that **spawns** the MCP server:
   - Cursor (typical)
   - Terminal / iTerm if you smoke-test from a shell
   - `node` only if you launch node from a context that is not already covered
3. **Quit and reopen** that app. TCC is checked at launch.
4. Optional send: Privacy & Security → Automation → allow that same app to control Messages.

Smoke: `npx tsx src/index.ts` does nothing useful alone (stdio). Call `messages_status` from Inspector or Cursor. On a fresh Mac with no Messages history, `NOT_FOUND` is expected.

---

## 5. Phase 1 tools and JSON schemas

All tools return a JSON text block. Errors are `{ "error": { "code", "message" } }` with `isError: true`.

### `messages_status`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

Reports `readable`, `fda_likely_missing`, `macos`, `send_enabled`, `unscoped`, `temp_copy_bytes`, `snapshot_age_ms`, and `scope`. `unscoped` is true only when `MESSAGES_ALLOW_UNSCOPED=1`. With empty `MESSAGES_SCOPE` and the flag unset, `scope.matched` is false and `candidates` lists group titles only. No message bodies.

### `messages_list_chats`

```json
{
  "type": "object",
  "properties": {
    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
    "query": { "type": "string" }
  },
  "additionalProperties": false
}
```

Recent chats by last message date. If an allowlist is set, only those chats.

### `messages_get_thread`

```json
{
  "type": "object",
  "properties": {
    "chat_id": { "type": "integer", "minimum": 1 },
    "handle": { "type": "string" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
    "before": { "type": ["integer", "string"] },
    "include_reactions": { "type": "boolean" },
    "from_date": { "type": "string" },
    "to_date": { "type": "string" }
  },
  "additionalProperties": false
}
```

`chat_id` is `chat.ROWID` (a page number; it can move across restore). Prefer `guid` to remember a thread. `handle` is a phone/email (punctuation-tolerant) or a `guid`. Omitted only works when the allowlist resolved to exactly one chat; unscoped calls must pass `chat_id` or `handle`. `before` is a `message_id` or ISO-8601 timestamp. `from_date` / `to_date` filter on the converted Apple date. Page is oldest-first.

### `messages_search`

```json
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "minLength": 1 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
    "chat_id": { "type": "integer", "minimum": 1 },
    "from_date": { "type": "string" },
    "to_date": { "type": "string" }
  },
  "additionalProperties": false
}
```

Two-phase, no FTS in `chat.db`: SQL `LIKE` on the plain `text` column, then a bounded decode-scan of empty-`text` / Tahoe rows. Returns `truncated` and `scanned` when that window is exhausted. With no `chat_id`, searches all readable chats or the allowlist.

### `messages_send` (unregistered unless armed)

```json
{
  "type": "object",
  "required": ["to", "body"],
  "properties": {
    "to": { "type": "string", "minLength": 1 },
    "body": { "type": "string", "minLength": 1 },
    "confirm": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

Registered only when `ENABLE_SEND=1`. `confirm` must be `true` or the tool returns `INVALID_ARGS`. `to` is resolved in process to one in-scope chat (`guid` / handle / `chat_id` / display name), then passed to AppleScript as argv. This sends a real message.

Error codes: `NOT_FOUND`, `PERMISSION`, `OPEN_FAILED`, `SCOPE`, `SEND_DISABLED`, `SEND_FAILED`, `INVALID_ARGS`, `UNSUPPORTED`.

---

## 6. Phase 1 vs Phase 2

| | Phase 1 | Phase 2 (this repo) | Later |
| --- | --- | --- | --- |
| Read chats / thread / search | Yes | — | — |
| Attachment **metadata** | Yes | — | Optional file bytes |
| Send | Optional env gate | Same path | — |
| Contacts names | No | No | AddressBook (more TCC) |
| Watcher / wake | — | `watch` CLI + JSON lines / hook | — |
| Push / Slack-style channel | No | No. Do not invent one. | — |

### Phase 2 watcher hook

There is no Apple-supported push of new SMS/iMessage into a third-party agent. The MCP stdio process **cannot** emit wakes on stdout (that stream is JSON-RPC). Run a **second process**:

```bash
npx tsx src/index.ts watch --interval 3000
# or
MESSAGES_WAKE_HOOK=/ABS/PATH/TO/apple-messages-mcp/examples/wake-hook.sh \
  npx tsx src/index.ts watch
```

What it does:

1. Resolves `MESSAGES_SCOPE`. Empty scope + flag unset → `SCOPE`. `MESSAGES_ALLOW_UNSCOPED=1` watches every chat.
2. Per-chat watermark: `Map<chat_id, last_rowid>`. Two chats moving in one tick emit two `messages.new` events. Still no bodies.
3. Shares the process warm snapshot. Polls every `MESSAGES_WATCH_INTERVAL_MS` (default 3000). `fs.watch` sets `dirty`; the interval does not overwrite that when watch is on (`MESSAGES_WATCH_FS=0` falls back to interval-as-poll).
4. Writes one JSON object per line to **stdout** of the watch process:
   - `{"type":"messages.ready", "chat_id", "guid", "chat_identifier", "display_name", "newest_message_id", "newest_at"}`
   - `{"type":"messages.new", "chat_id", "guid", "chat_identifier", "newest_message_id", "previous_message_id", "count_new", "newest_at", "preview"}`
5. If `MESSAGES_WAKE_HOOK` is set, also spawns that executable and writes the same JSON to its stdin (no shell).
6. `preview` is omitted unless `--preview` / `WATCH_INCLUDE_PREVIEW=1`, and is **always redacted** (`[redacted N chars]`). The host should call `messages_get_thread` after a wake.

This is a local callback. It is not a hosted inbox, not MCP notifications inside Cursor, and not continuous push from Apple. Grok Bot (or a launchd plist) reads the pipe / hook and starts an agent turn.

---

## 7. Cursor `AddMcpServer` / `mcp.json`

Stdio server. Cursor stores the same three fields the dialog asks for: `command`, `args`, `env`.

```json
{
  "mcpServers": {
    "apple-messages": {
      "command": "node",
      "args": [
        "/ABS/PATH/TO/apple-messages-mcp/dist/index.js"
      ],
      "env": {
        "MESSAGES_DB_MODE": "copy",
        "ENABLE_SEND": "0",
        "REDACT_PREVIEWS": "0"
      }
    }
  }
}
```

Dev: `npx tsx src/index.ts`. A personal Grok Bot that wants the whole inbox sets `MESSAGES_ALLOW_UNSCOPED=1`. A family/work box sets `MESSAGES_SCOPE`.

| Env | Default | Meaning |
| --- | --- | --- |
| `MESSAGES_SCOPE` | unset | Comma/semicolon tokens: display name, `chat_id`, `guid`, handle |
| `MESSAGES_ALLOW_UNSCOPED` | `0` | `1` is the only way to open the whole inbox |
| `MESSAGES_DB_PATH` | `~/Library/Messages/chat.db` | Fixture or alt home |
| `MESSAGES_DB_MODE` | `copy` | `direct` skips the temp copy |
| `ENABLE_SEND` | `0` | `1` allows `messages_send` |
| `REDACT_PREVIEWS` | `0` | Replace bodies with `[redacted N chars]` |
| `MESSAGES_WATCH_INTERVAL_MS` | `3000` | Watcher poll interval |
| `MESSAGES_WATCH_FS` | `1` | `0` disables `fs.watch` |
| `MESSAGES_WAKE_HOOK` | unset | Executable that receives one JSON event on stdin |
| `WATCH_INCLUDE_PREVIEW` | `0` | Include a redacted preview on `messages.new` |

Claude Desktop uses the same `mcpServers` object in `claude_desktop_config.json`.

---

## 8. What Grok Bot / Cursor agents should set as MCP instructions

Paste this into the agent's MCP / project instructions (not into a remote prompt that will be logged with message bodies):

```
You have a local Apple Messages MCP. By default it is scoped shut.
messages_status.unscoped is true only if MESSAGES_ALLOW_UNSCOPED=1.

Rules:
- Call messages_status before diagnosing failures. If fda_likely_missing
  is true, tell the user to grant Full Disk Access to Cursor and restart.
- Pass chat_id (chat.ROWID), guid, or handle when calling
  messages_get_thread. Prefer guid to remember a thread across launches.
  Do not guess a default group.
- If list/search/thread returns SCOPE, read scope.candidates (group
  titles only) and ask the user to set MESSAGES_SCOPE or
  MESSAGES_ALLOW_UNSCOPED=1. Stay inside the allowlist.
- Handles are phone numbers and emails, not Contacts names. Do not invent
  surnames. chat_id is chat.ROWID; message_id is message.ROWID.
- Never paste full threads into tickets, emails, or other MCP servers.
  Summarize. If REDACT_PREVIEWS=1, you will only see length placeholders.
- messages_send is not registered unless ENABLE_SEND=1. When it is,
  require confirm: true after the user accepted the exact recipient and
  body. Do not send without that.
- There is no live push inside MCP. A separate watch process emits
  JSON-line wakes (one messages.new per chat that moved). After a wake,
  call messages_get_thread. Do not treat the watcher as a chat channel.
```

---

## 9. Non-goals

- Inkbox / Linq / any hosted agent number
- Reading attachment binaries or Photos
- Linking Memoji / Contacts avatars
- Disabling SIP, injecting into `imagent`, or scraping the Messages window
- Shipping `chat.db` off the Mac

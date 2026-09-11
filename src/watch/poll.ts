import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import type { Config } from "../types.ts";
import { MessagesError } from "../types.ts";
import { withChatDb } from "../db/open.ts";
import { isScopeActive } from "../config.ts";
import {
  countMessagesAfterInChat,
  getChatWatermarks,
  getThread,
  resolveScope,
} from "../db/queries.ts";
import { maybeRedact } from "../redact.ts";
import { logInfo } from "../log.ts";

export type WakeEvent =
  | {
      type: "messages.ready";
      chat_id: number;
      guid: string | null;
      chat_identifier: string | null;
      display_name: string | null;
      newest_message_id: number | null;
      newest_at: string | null;
    }
  | {
      type: "messages.new";
      chat_id: number;
      guid: string | null;
      chat_identifier: string | null;
      display_name: string | null;
      newest_message_id: number;
      previous_message_id: number | null;
      count_new: number;
      newest_at: string | null;
      preview: string | null;
    }
  | {
      type: "messages.error";
      code: string;
      message: string;
    };

export type WatcherState = {
  watermarks: Record<number, number>;
  ready: boolean;
};

export type WatchOptions = {
  includePreview: boolean;
};

export function emptyWatcherState(): WatcherState {
  return { watermarks: {}, ready: false };
}

export function pollOnce(
  config: Config,
  state: WatcherState,
  options: WatchOptions,
): { state: WatcherState; events: WakeEvent[] } {
  try {
    return withChatDb(config.dbPath, config.dbMode, (db) => {
      const scope = resolveScope(db, config);
      if (isScopeActive(config) && !scope.matched) {
        return {
          state,
          events: [
            {
              type: "messages.error",
              code: "SCOPE",
              message: `Allowlist ${scope.allowlist.join(", ") || "(empty)"} matched no chats.`,
            },
          ],
        };
      }

      const chatIds = isScopeActive(config)
        ? scope.chats.map((chat) => chat.chat_id)
        : null;
      const marks = getChatWatermarks(db, chatIds);
      const nextWatermarks: Record<number, number> = {};
      for (const mark of marks) {
        nextWatermarks[mark.chat_id] = mark.newest_message_id;
      }
      const next: WatcherState = { watermarks: nextWatermarks, ready: true };

      if (!state.ready) {
        const primary =
          chatIds && chatIds.length === 1
            ? marks.find((mark) => mark.chat_id === chatIds[0]) ?? marks[0]
            : marks.reduce<(typeof marks)[number] | undefined>(
                (best, mark) =>
                  !best || mark.newest_message_id > best.newest_message_id ? mark : best,
                undefined,
              );
        return {
          state: next,
          events: [
            {
              type: "messages.ready",
              chat_id: primary?.chat_id ?? 0,
              guid: primary?.guid ?? null,
              chat_identifier: primary?.chat_identifier ?? null,
              display_name:
                chatIds && chatIds.length === 1 ? (primary?.display_name ?? null) : null,
              newest_message_id: primary?.newest_message_id ?? null,
              newest_at: primary?.newest_at ?? null,
            },
          ],
        };
      }

      const events: WakeEvent[] = [];
      for (const mark of marks) {
        const previous = state.watermarks[mark.chat_id] ?? 0;
        if (mark.newest_message_id <= previous) continue;

        let preview: string | null = null;
        if (options.includePreview) {
          const newest = getThread(db, {
            chatId: mark.chat_id,
            limit: 1,
            redact: false,
          });
          preview = maybeRedact(newest[0]?.text ?? "", true);
        }

        events.push({
          type: "messages.new",
          chat_id: mark.chat_id,
          guid: mark.guid,
          chat_identifier: mark.chat_identifier,
          display_name: mark.display_name,
          newest_message_id: mark.newest_message_id,
          previous_message_id: previous || null,
          count_new: countMessagesAfterInChat(db, mark.chat_id, previous),
          newest_at: mark.newest_at,
          preview,
        });
      }

      return { state: next, events };
    });
  } catch (err) {
    if (err instanceof MessagesError) {
      return {
        state,
        events: [{ type: "messages.error", code: err.code, message: err.message }],
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      state,
      events: [{ type: "messages.error", code: "OPEN_FAILED", message }],
    };
  }
}

export function emitWakeJson(event: WakeEvent, write: (line: string) => void): void {
  write(`${JSON.stringify(event)}\n`);
}

export function runWakeHook(command: string, event: WakeEvent): void {
  const child = spawn(command, {
    stdio: ["pipe", "ignore", "pipe"],
    shell: false,
  });
  child.stdin.write(JSON.stringify(event));
  child.stdin.end();
  child.on("exit", (code) => {
    logInfo("wake_hook", { type: event.type, code: code ?? -1 });
  });
  child.on("error", (err) => {
    logInfo("wake_hook_error", { message: err.message });
  });
}

export type RunWatcherArgs = {
  config: Config;
  intervalMs: number;
  includePreview: boolean;
  useFsWatch: boolean;
  wakeHook: string | null;
  signal?: AbortSignal;
  writeLine?: (line: string) => void;
};

/**
 * Poll chat.db for new ROWIDs (allowlist if configured, otherwise all chats).
 * This is a local wake hook, not Apple push and not an MCP channel.
 */
export async function runWatcher(args: RunWatcherArgs): Promise<void> {
  const write = args.writeLine ?? ((line) => process.stdout.write(line));
  let state = emptyWatcherState();
  let dirty = true;

  const tick = (): void => {
    if (args.signal?.aborted) return;
    if (!dirty) return;
    dirty = false;
    const result = pollOnce(args.config, state, {
      includePreview: args.includePreview,
    });
    state = result.state;
    for (const event of result.events) {
      if (event.type === "messages.error") {
        logInfo("watch_error", { code: event.code });
      } else {
        logInfo("watch", {
          type: event.type,
          chat_id: event.chat_id,
          newest: event.newest_message_id,
        });
      }
      emitWakeJson(event, write);
      if (args.wakeHook) runWakeHook(args.wakeHook, event);
    }
  };

  const watchers: Array<ReturnType<typeof watch>> = [];
  if (args.useFsWatch) {
    const targets = [args.config.dbPath, `${args.config.dbPath}-wal`].filter((p) =>
      existsSync(p),
    );
    for (const target of targets) {
      try {
        watchers.push(
          watch(target, () => {
            dirty = true;
          }),
        );
      } catch {
        /* fs.watch is optional; interval still polls when useFsWatch is off */
      }
    }
  }

  dirty = true;
  tick();

  const timer = setInterval(() => {
    if (!args.useFsWatch) dirty = true;
    tick();
  }, args.intervalMs);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      clearInterval(timer);
      for (const watcher of watchers) watcher.close();
      resolve();
    };
    if (args.signal) {
      if (args.signal.aborted) stop();
      else args.signal.addEventListener("abort", stop, { once: true });
    }
  });
}

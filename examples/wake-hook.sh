#!/bin/sh
# Phase 2 wake hook example.
# The watcher writes one JSON object to stdin (messages.ready | messages.new).
# This is a local callback — not Apple push and not a chat channel.
# Swap the log line for whatever starts a Grok Bot / Cursor agent turn.

set -eu
node --input-type=module -e '
import { readFileSync } from "node:fs";
const event = JSON.parse(readFileSync(0, "utf8"));
console.error(`wake ${event.type} chat_id=${event.chat_id ?? ""} newest=${event.newest_message_id ?? ""}`);
'

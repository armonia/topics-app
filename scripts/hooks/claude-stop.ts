#!/usr/bin/env bun
/**
 * Claude Code `Stop` hook → Topics events.
 *
 * Reads the JSON event Claude Code passes on stdin, classifies severity
 * (P0/P1/P2/skip), and appends an event line to ~/.topics/events.jsonl
 * for the Topics tray app and FS watcher to pick up.
 *
 * Posts a macOS DistributedNotification when severity ≥ P1 so the tray
 * app receives a real-time push (NOTIF-01 — triple-layer first leg).
 *
 * Non-invasive: never blocks; routine events (idle, progress) emit nothing.
 *
 * Install in ~/.claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "Stop":         [{ "command": "bun ~/Projects/topics-app/scripts/hooks/claude-stop.ts" }],
 *       "PreToolUse":   [{ "command": "bun ~/Projects/topics-app/scripts/hooks/claude-pretooluse.ts" }]
 *     }
 *   }
 *
 * Spec: openspec/changes/add-master-topic-mode/specs/notifications/spec.md
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOPICS_HOME = process.env.TOPICS_HOME || join(homedir(), ".topics");
const EVENTS_PATH = join(TOPICS_HOME, "events.jsonl");

type Severity = "P0" | "P1" | "P2" | "SKIP";

interface ClaudeStopPayload {
  // Claude Code's actual hook payload shape varies by version.
  // We're defensive — accept whatever we get.
  session_id?: string;
  reason?: string;
  awaiting_permission?: boolean;
  awaiting_user_input?: boolean;
  error?: string | { message?: string };
  task_complete?: boolean;
  cwd?: string;
}

function classify(payload: ClaudeStopPayload): Severity {
  if (payload.error) return "P0";
  if (payload.awaiting_permission || payload.awaiting_user_input) return "P1";
  if (payload.task_complete) return "P1";
  return "P2";
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    // Defensive: if stdin doesn't close in 2s, resolve with what we have.
    setTimeout(() => resolve(buf), 2000);
  });
}

async function main() {
  try {
    const raw = await readStdin();
    let payload: ClaudeStopPayload = {};
    if (raw.trim()) {
      try { payload = JSON.parse(raw); } catch { /* tolerate */ }
    }
    const severity = classify(payload);
    if (severity === "SKIP") {
      process.exit(0);
      return;
    }

    if (!existsSync(TOPICS_HOME)) mkdirSync(TOPICS_HOME, { recursive: true });

    const event = {
      ts: Date.now(),
      kind: "stop",
      severity,
      payload,
    };
    appendFileSync(EVENTS_PATH, JSON.stringify(event) + "\n");

    // No user-visible banner from here anymore: appending to events.jsonl is the
    // whole job. The Topics app watches this file (server claude-events-watcher →
    // WS "claude-event" → client), and shows the P0/P1 banner via its native
    // notification path — so the hook no longer shells out to `osascript`
    // (which was triggering a macOS "control iTunes/Music" Automation prompt).

    process.exit(0);
  } catch (err: any) {
    // Hooks MUST NOT fail loudly — Claude Code would surface the error to
    // the user. Log to stderr (collected silently) and exit 0.
    console.error(`[topics-hook] ${err?.message ?? err}`);
    process.exit(0);
  }
}

main();

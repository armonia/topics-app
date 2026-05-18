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
import { spawn } from "node:child_process";

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

function postDarwinNotification(severity: Severity, payload: ClaudeStopPayload) {
  // macOS: post a DistributedNotification the Topics tray subscribes to.
  // We use `osascript` for a user-visible notification too, but the
  // distributed notification is the cheap real-time channel.
  if (process.platform !== "darwin") return;
  const title = severity === "P0" ? "Topics · Blocker"
              : severity === "P1" ? "Topics · Awaiting Review"
              : "Topics";
  const message = payload.reason || (payload.cwd ? `in ${payload.cwd}` : "Session update");
  const sound = severity === "P0" ? "Funk" : "";
  const script = sound
    ? `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name ${JSON.stringify(sound)}`
    : `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  try {
    spawn("/usr/bin/osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Non-fatal: notification is best-effort.
  }
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

    if (severity === "P0" || severity === "P1") {
      postDarwinNotification(severity, payload);
    }

    process.exit(0);
  } catch (err: any) {
    // Hooks MUST NOT fail loudly — Claude Code would surface the error to
    // the user. Log to stderr (collected silently) and exit 0.
    console.error(`[topics-hook] ${err?.message ?? err}`);
    process.exit(0);
  }
}

main();

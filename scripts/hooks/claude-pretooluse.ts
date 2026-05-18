#!/usr/bin/env bun
/**
 * Claude Code `PreToolUse` hook → Topics events.
 *
 * Logs tool-use events for the reasoning trail (Phase E) but DOES NOT
 * notify the user (NOTIF-05 — routine activity is silent). Append-only.
 *
 * Exit 0 always (never block tool calls).
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOPICS_HOME = process.env.TOPICS_HOME || join(homedir(), ".topics");
const EVENTS_PATH = join(TOPICS_HOME, "events.jsonl");

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    setTimeout(() => resolve(buf), 1000);
  });
}

async function main() {
  try {
    const raw = await readStdin();
    let payload: unknown = {};
    if (raw.trim()) {
      try { payload = JSON.parse(raw); } catch { /* tolerate */ }
    }
    if (!existsSync(TOPICS_HOME)) mkdirSync(TOPICS_HOME, { recursive: true });
    const event = {
      ts: Date.now(),
      kind: "pre_tool_use",
      severity: "P2",
      payload,
    };
    appendFileSync(EVENTS_PATH, JSON.stringify(event) + "\n");
    process.exit(0);
  } catch (err: any) {
    console.error(`[topics-hook] ${err?.message ?? err}`);
    process.exit(0);
  }
}

main();

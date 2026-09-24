#!/usr/bin/env bun
/**
 * A FAKE CLI THAT RESUMES WITH A LEFTOVER TASK NOTIFICATION.
 *
 * Replays, line by line, what Claude Code 2.1.280 printed on 24/09/2026 when a
 * session that had a background task at its last exit was resumed with
 * `--resume`: before it reads stdin, it answers the task's notification with a
 * turn of its own and an EMPTY result (zero model turns).
 *
 *   {"type":"system","subtype":"task_notification","status":"stopped",...}
 *   {"type":"system","subtype":"init",...}
 *   {"type":"result","subtype":"success","num_turns":0,"result":"",...}
 *
 * Then every message on stdin gets a normal answer. The first frame arrives
 * before the person's message is even written, which is exactly the race
 * that closed a person's message on topic 33966f4e as "no reply" in 1.5 s.
 */

// A module, not a global script: the other fake CLIs in this folder declare
// the same top-level names, and the typecheck sees them all at once.
export {};

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function init(): void {
  out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
}

// The notification's own turn, emitted at startup (recorded shape).
out({
  type: "system",
  subtype: "task_notification",
  task_id: "bcpwzslsf",
  tool_use_id: "toolu_01B44wb1PAZMSiyptdExUXzb",
  status: "stopped",
  output_file: "",
  summary: "Background shell command didn't finish before the previous session ended",
  session_id: SESSION_ID,
});
init();
out({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  stop_reason: null,
  session_id: SESSION_ID,
  result: "",
  duration_ms: 48,
  total_cost_usd: 0,
});

function answer(text: string): void {
  init();
  out({
    type: "assistant",
    session_id: SESSION_ID,
    message: { role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 4 }, model: "claude-finto" },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: SESSION_ID,
    result: text,
    duration_ms: 90,
    total_cost_usd: 0,
  });
}

function textOf(line: string): string | null {
  try {
    const o = JSON.parse(line) as { message?: { content?: unknown } };
    const c = o?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object")
        .map((b) => (b.type === "text" ? b.text ?? "" : ""))
        .join("");
    }
  } catch { /* not JSON: ignored */ }
  return null;
}

let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += chunk.toString();
  let nl: number;
  while ((nl = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (!line) continue;
    const text = textOf(line);
    if (text === null) continue;
    answer(`ricevuto: ${text.slice(0, 200)}`);
  }
});

process.stdin.on("end", () => process.exit(0));

#!/usr/bin/env bun
/**
 * A FAKE CLI THAT DIES ON SIGINT THE WAY THE REAL ONE DOES.
 *
 * Recorded with Claude Code 2.1.280 on 24/09/2026 in stream-json mode: a
 * SIGINT during a turn prints the stopped turn's tail and the process EXITS
 * with code 0 about half a second later. The next message is never read.
 *
 *   {"type":"user","message":{"content":[{"type":"tool_result","is_error":true,...}]}}
 *   {"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}
 *   {"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":3,"result":""}
 *   (exit 0)
 *
 * A message containing "work" starts a turn that never ends on its own (a
 * tool that runs until stopped). Any other message gets a normal answer.
 */

// A module, not a global script: the other fake CLIs in this folder declare
// the same top-level names, and the typecheck sees them all at once.
export {};

const SESSION_ID = "00000000-0000-4000-8000-000000000002";
let working = false;

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function init(): void {
  out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
}

function startWork(): void {
  init();
  out({
    type: "assistant",
    session_id: SESSION_ID,
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_long", name: "Bash", input: { command: "sleep 600" } }], model: "claude-finto" },
  });
  working = true;
}

function answer(text: string): void {
  init();
  out({
    type: "assistant",
    session_id: SESSION_ID,
    message: { role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 4 }, model: "claude-finto" },
  });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", session_id: SESSION_ID, result: text, duration_ms: 90, total_cost_usd: 0 });
}

process.on("SIGINT", () => {
  if (working) {
    out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: "toolu_long", content: "The user doesn't want to proceed with this tool use." }] } });
    out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 3, stop_reason: "tool_use", session_id: SESSION_ID, result: "", duration_ms: 4658 });
  }
  // The real CLI takes 0.3-0.7 s to go.
  setTimeout(() => process.exit(0), 400);
});

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
    if (text.includes("work")) startWork();
    else answer(`ricevuto: ${text.slice(0, 200)}`);
  }
});

process.stdin.on("end", () => process.exit(0));

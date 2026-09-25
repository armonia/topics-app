#!/usr/bin/env bun
/**
 * A FAKE CLI WHOSE TURN ENDS WHILE NO SERVER IS LISTENING (card 98ce88d1).
 *
 * A message containing "report" starts a turn in the shape of a real one: a
 * line of text, a tool, and then nothing until the file `finish-turn` appears
 * in the working directory. Then the tool's result, the final report and the
 * `result` that closes the turn. The test creates the file once the server has
 * detached from the broker, so the whole end of the turn lands in the broker's
 * store and nowhere else, as it did on 25/09 at 17:27:58.
 *
 * The final report goes out twice in the text deltas' shape the real CLI uses
 * (`--include-partial-messages`), then as the cumulative assistant message.
 *
 * The review of PR #145 added the turns around it (its probe's fake, ported):
 * "OLDTURN" answers at once; "COMPACTNOW" is a `/compact` (an init, a boundary,
 * an empty result); "AFTERCOMPACT" waits for `finish-turn` like "report";
 * "DELAYED" is read but its turn never starts (the SIGTERM that comes before
 * the CLI's init). Every `duration_ms` is the turn's real length.
 */

// A module, not a global script: the other fake CLIs in this folder declare
// the same top-level names, and the typecheck sees them all at once.
export {};

import { existsSync, writeFileSync } from "fs";
import { join } from "path";

const SESSION_ID = "00000000-0000-4000-8000-000000000098";
const FIRST_TEXT = "Committing WIP, then building the branch bundle.";
const FINAL_REPORT = "PR aggiornata a `0ea0f9130`: tutti i punti chiusi, commento sulla card fatto.";

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function assistant(content: unknown[]): void {
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content, model: "claude-finto" } });
}

function startTurn(): void {
  // `duration_ms` is the turn's real length, as the CLI reports it: the reattach dates the turn's start from it.
  const started = Date.now();
  out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
  assistant([{ type: "text", text: FIRST_TEXT }]);
  assistant([{ type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "bun run build" } }]);
  const finish = join(process.cwd(), "finish-turn");
  const wait = setInterval(() => {
    if (!existsSync(finish)) return;
    clearInterval(wait);
    out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_build", content: "built" }] } });
    const half = Math.floor(FINAL_REPORT.length / 2);
    for (const text of [FINAL_REPORT.slice(0, half), FINAL_REPORT.slice(half)]) {
      out({ type: "stream_event", session_id: SESSION_ID, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
    }
    assistant([{ type: "text", text: FINAL_REPORT }]);
    out({ type: "result", subtype: "success", is_error: false, num_turns: 3, stop_reason: "end_turn", session_id: SESSION_ID, result: FINAL_REPORT, duration_ms: Date.now() - started, total_cost_usd: 0 });
  }, 50);
}

function touch(name: string): void {
  writeFileSync(join(process.cwd(), name), "");
}

function whenFile(name: string, fn: () => void): void {
  const wait = setInterval(() => { if (existsSync(join(process.cwd(), name))) { clearInterval(wait); fn(); } }, 50);
}

function result(text: string, started: number, numTurns = 2): void {
  out({ type: "result", subtype: "success", is_error: false, num_turns: numTurns, stop_reason: numTurns ? "end_turn" : null, session_id: SESSION_ID, result: text, duration_ms: Date.now() - started, total_cost_usd: 0 });
}

function reviewTurn(text: string): boolean {
  const started = Date.now();
  const init = () => out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
  if (/OLDTURN/.test(text)) {
    init();
    assistant([{ type: "text", text: "OLD-A: first part of the old answer." }]);
    assistant([{ type: "tool_use", id: "toolu_old", name: "Bash", input: { command: "ls" } }]);
    out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "x" }] } });
    assistant([{ type: "text", text: "OLD-B: the old final report." }]);
    result("OLD-B: the old final report.", started);
  } else if (/COMPACTNOW/.test(text)) {
    init();
    out({ type: "system", subtype: "compact_boundary", session_id: SESSION_ID, compact_metadata: { trigger: "manual", pre_tokens: 574474 } });
    result("", started, 0);
  } else if (/AFTERCOMPACT/.test(text)) {
    init();
    assistant([{ type: "text", text: "AC-FIRST." }]);
    assistant([{ type: "tool_use", id: "toolu_ac", name: "Bash", input: { command: "make" } }]);
    whenFile("finish-turn", () => {
      out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ac", content: "built" }] } });
      assistant([{ type: "text", text: "AC-FINAL report." }]);
      result("AC-FINAL report.", started);
    });
  } else if (/DELAYED/.test(text)) {
    touch("got-delayed");
  } else {
    return false;
  }
  return true;
}

function answer(text: string): void {
  out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
  assistant([{ type: "text", text }]);
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", session_id: SESSION_ID, result: text, duration_ms: 90, total_cost_usd: 0 });
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
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    const text = textOf(line);
    if (text === null) continue;
    if (reviewTurn(text)) continue;
    if (/report/.test(text)) startTurn();
    else answer("ok");
  }
});

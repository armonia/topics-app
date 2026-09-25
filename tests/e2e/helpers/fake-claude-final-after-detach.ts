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
 */

// A module, not a global script: the other fake CLIs in this folder declare
// the same top-level names, and the typecheck sees them all at once.
export {};

import { existsSync } from "fs";
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
    out({ type: "result", subtype: "success", is_error: false, num_turns: 3, stop_reason: "end_turn", session_id: SESSION_ID, result: FINAL_REPORT, duration_ms: 1200, total_cost_usd: 0 });
  }, 50);
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
    if (/report/.test(text)) startTurn();
    else answer("ok");
  }
});

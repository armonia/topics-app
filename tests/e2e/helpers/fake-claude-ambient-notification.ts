#!/usr/bin/env bun
/**
 * A FAKE CLI WHOSE NOTIFICATION NEVER GETS A TURN OF ITS OWN.
 *
 * After answering the first message it prints a `task_notification` marked
 * ambient and no result for it, the case the adversarial check raised on
 * 24/09: a notification seen while the session is idle whose own turn never
 * comes. Then `/reset` answers the way Claude Code 2.1.280 does: a
 * conversation reset and an EMPTY result with zero model turns.
 *
 * Any other message gets a normal answer.
 */

// A module, not a global script: the other fake CLIs in this folder declare
// the same top-level names, and the typecheck sees them all at once.
export {};

const SESSION_ID = "00000000-0000-4000-8000-000000000003";
let answered = 0;

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function init(): void {
  out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
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

function reset(): void {
  out({ type: "conversation_reset", session_id: SESSION_ID });
  init();
  out({ type: "result", subtype: "success", is_error: false, num_turns: 0, stop_reason: null, session_id: SESSION_ID, result: "", duration_ms: 12, total_cost_usd: 0 });
}

/** `/compact` with nothing to compact: a line of text, no boundary, an empty result. */
function compactNothing(): void {
  init();
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text: "Error: No messages to compact" }], model: "claude-finto" } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 0, stop_reason: null, session_id: SESSION_ID, result: "", duration_ms: 9, total_cost_usd: 0 });
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
    if (text.trim() === "/reset") { reset(); continue; }
    if (text.trim() === "/compact") { compactNothing(); continue; }
    answer(`ricevuto: ${text.slice(0, 200)}`);
    // Idle now. A notification arrives and no turn of its own follows.
    out({ type: "system", subtype: "task_notification", task_id: `amb${++answered}`, status: "completed", skip_transcript: true, ambient: true, session_id: SESSION_ID });
  }
});

process.stdin.on("end", () => process.exit(0));

#!/usr/bin/env bun
/**
 * A FAKE CLI WHOSE TOOL PRINTS NOTHING FOR A WHILE.
 *
 * "silent N" starts a turn that says one line, starts a Bash, and then emits
 * nothing for N seconds (a long build, a wait on a Monitor), then gets its tool
 * result and ends with "SILENT-TOOL-DONE". The process stays alive the whole
 * time, which is what the stale-stream sweep asks.
 *
 * "pulse A B" is the same turn in two silences: a Bash quiet for A seconds,
 * then one line ("PULSE-TEXT"), B more seconds of nothing, a second Bash
 * ("echo relit"), and "PULSE-DONE". Any other message gets a plain answer.
 */

// A module, not a global script: the other fake CLIs in this folder declare
// the same top-level names, and the typecheck sees them all at once.
export {};

const SESSION_ID = "00000000-0000-4000-8000-000000000003";
let working: ReturnType<typeof setTimeout> | null = null;

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function assistant(content: unknown[]): void {
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content, model: "claude-finto" } });
}

function finish(text: string): void {
  assistant([{ type: "text", text }]);
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", session_id: SESSION_ID, result: text, duration_ms: 90, total_cost_usd: 0 });
}

function startSilentTool(seconds: number): void {
  out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
  assistant([{ type: "text", text: "Starting a silent tool." }]);
  assistant([{ type: "tool_use", id: "toolu_silent", name: "Bash", input: { command: `sleep ${seconds}` } }]);
  working = setTimeout(() => {
    working = null;
    out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_silent", content: "" }] } });
    finish("SILENT-TOOL-DONE");
  }, seconds * 1000);
}

function startPulse(a: number, b: number): void {
  out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
  assistant([{ type: "tool_use", id: "toolu_quiet", name: "Bash", input: { command: `sleep ${a}` } }]);
  working = setTimeout(() => {
    out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_quiet", content: "" }] } });
    assistant([{ type: "text", text: "PULSE-TEXT" }]);
    working = setTimeout(() => {
      assistant([{ type: "tool_use", id: "toolu_relit", name: "Bash", input: { command: "echo relit" } }]);
      working = setTimeout(() => {
        working = null;
        out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_relit", content: "relit" }] } });
        finish("PULSE-DONE");
      }, 3_000);
    }, b * 1000);
  }, a * 1000);
}

process.on("SIGINT", () => {
  if (working) clearTimeout(working);
  setTimeout(() => process.exit(0), 400);
});

function textOf(line: string): string | null {
  try {
    const c = (JSON.parse(line) as { message?: { content?: unknown } })?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((b) => {
        const block = b as { type?: string; text?: string } | null;
        return block?.type === "text" ? block.text ?? "" : "";
      }).join("");
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
    const text = line ? textOf(line) : null;
    if (text === null) continue;
    const silent = /silent (\d+)/.exec(text);
    const pulse = /pulse (\d+) (\d+)/.exec(text);
    if (silent) startSilentTool(Number(silent[1]));
    else if (pulse) startPulse(Number(pulse[1]), Number(pulse[2]));
    else {
      out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
      finish(`got: ${text.slice(0, 200)}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));

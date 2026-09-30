#!/usr/bin/env bun
/**
 * A FAKE CLI WHOSE TURN LEAVES A BACKGROUND JOB RUNNING.
 *
 * "bgkeep-start" is a turn that launches a background Bash ("BGKEEP-JOB") and
 * ends while the job goes on, printing the lines Claude Code 2.1.282 prints
 * for it (`tests/fixtures/claude-cli-2.1.282-background-work.ndjson`): the
 * `background_tasks_changed` snapshot, the `task_started`, then the result.
 *
 * "bgkeep-hold" is a turn that says "HOLDING" and stays open until the file
 * `release` appears in `$BGKEEP_DIR`. The job ends when the file `end-job`
 * appears there: the snapshot empties, the task reports, and the CLI wakes
 * with a turn of its own ("BG-JOB-REPORTED"), as the recording shows.
 *
 * Files and not stdin: while a turn is open the server holds the next message,
 * and the test must end the turn and the job at moments it picks.
 */

// A module, not a global script: the other fake CLIs in this folder declare
// the same top-level names, and the typecheck sees them all at once.
import { existsSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID = "00000000-0000-4000-8000-000000000005";
const DIR = process.env.BGKEEP_DIR ?? "";
const JOB = { task_id: "bgkeep1", task_type: "local_bash", description: "BGKEEP-JOB" };
let holding = false;
let jobRunning = false;

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function init(): void {
  out({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-finto", tools: [], fast_mode_state: "off" });
}

function say(text: string): void {
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text }], model: "claude-finto" } });
}

function finish(text: string): void {
  say(text);
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", session_id: SESSION_ID, result: text, duration_ms: 90, total_cost_usd: 0 });
}

function startJob(): void {
  init();
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bgkeep", name: "Bash", input: { command: "sleep 600", run_in_background: true } }], model: "claude-finto" } });
  out({ type: "system", subtype: "background_tasks_changed", tasks: [JOB], session_id: SESSION_ID });
  out({ type: "system", subtype: "task_started", task_id: JOB.task_id, tool_use_id: "toolu_bgkeep", description: JOB.description, is_backgrounded: true, task_type: JOB.task_type, session_id: SESSION_ID });
  out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bgkeep", content: `Command running in background with ID: ${JOB.task_id}` }] } });
  jobRunning = true;
  finish("BG-LAUNCHED");
}

function endJob(): void {
  jobRunning = false;
  out({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: SESSION_ID });
  out({ type: "system", subtype: "task_notification", task_id: JOB.task_id, tool_use_id: "toolu_bgkeep", status: "completed", summary: `Background command "${JOB.description}" completed (exit code 0)`, session_id: SESSION_ID });
  // The wake: the CLI answers the report with a turn of its own.
  init();
  finish("BG-JOB-REPORTED");
}

// The test's two switches, read a few times a second.
setInterval(() => {
  if (!DIR) return;
  if (holding && existsSync(join(DIR, "release"))) {
    holding = false;
    finish("HOLD-DONE");
  }
  if (jobRunning && !holding && existsSync(join(DIR, "end-job"))) endJob();
}, 150);

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
    if (text.includes("bgkeep-start")) startJob();
    else if (text.includes("bgkeep-hold")) {
      init();
      say("HOLDING");
      holding = true;
    } else {
      init();
      finish(`got: ${text.slice(0, 200)}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));

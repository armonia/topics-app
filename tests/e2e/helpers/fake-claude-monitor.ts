#!/usr/bin/env bun
/**
 * A FAKE CLI THAT ARMS A MONITOR MID-TURN, as Claude Code 2.1.285 does it
 * (`tests/fixtures/claude-cli-2.1.285-monitor-wakes.ndjson`).
 *
 * "monwatch-start" opens a turn that says "HOLDING" and waits for the file
 * `arm` in `$MONWATCH_DIR`: the Monitor is armed as late in the turn as the
 * test decides, well after the refresh `stream:start` triggers. It then calls
 * the Monitor tool ("MONWATCH-JOB"): the `assistant` tool_use, the
 * `background_tasks_changed` snapshot listing it as a `local_bash`, the
 * `task_started` naming the tool call, the receipt. It says "ARMED" and keeps
 * the turn open until the file `release` appears, and ends it with "ARM-DONE".
 *
 * The file `event` makes the Monitor deliver an event the way the real CLI
 * does: nothing on stdout names it. The notification is written to the CLI's
 * own transcript (`$MONWATCH_TRANSCRIPT`) as the `user` line of a new turn, and
 * stdout prints only that turn: `system/init`, "GOT-EVENT", its `result`.
 *
 * The file `end` ends the Monitor's stream: the snapshot empties, the task
 * reports, and the CLI wakes to answer it ("MON-ENDED"). As the real CLI does
 * (2.1.285, recorded), the transcript line of that wake carries the summary
 * `Monitor "MONWATCH-JOB" stream ended` and the Monitor's last event.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SESSION_ID = "00000000-0000-4000-8000-0000000000b7";
const DIR = process.env.MONWATCH_DIR ?? "";
const TRANSCRIPT = process.env.MONWATCH_TRANSCRIPT ?? "";
const CWD = process.env.MONWATCH_CWD ?? process.cwd();
const TASK = { task_id: "bmonwatch1", task_type: "local_bash", description: "MONWATCH-JOB" };
const TOOL = "toolu_monwatch";
let waitingArm = false;
let holding = false;
let armed = false;
let evented = false;

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function init(): void {
  out({ type: "system", subtype: "init", cwd: CWD, session_id: SESSION_ID, model: "claude-finto", tools: ["Monitor"], fast_mode_state: "off" });
}

function say(text: string): void {
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text }], model: "claude-finto" } });
}

function finish(text: string): void {
  say(text);
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", session_id: SESSION_ID, result: text, duration_ms: 90, total_cost_usd: 0 });
}

/** The line the CLI writes to its transcript when a notification opens a turn. */
function notify(summary: string, event: string): void {
  if (!TRANSCRIPT) return;
  mkdirSync(dirname(TRANSCRIPT), { recursive: true });
  const content = `<task-notification>\n<task-id>${TASK.task_id}</task-id>\n<summary>${summary}</summary>\n<event>${event}</event>\n</task-notification>`;
  appendFileSync(TRANSCRIPT, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), sessionId: SESSION_ID, cwd: CWD, origin: { kind: "task-notification" }, message: { role: "user", content } }) + "\n");
}

function arm(): void {
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "tool_use", id: TOOL, name: "Monitor", input: { description: TASK.description, command: "tail -f build.log", timeout_ms: 600000 } }], model: "claude-finto" } });
  out({ type: "system", subtype: "background_tasks_changed", tasks: [TASK], session_id: SESSION_ID });
  out({ type: "system", subtype: "task_started", task_id: TASK.task_id, tool_use_id: TOOL, description: TASK.description, is_backgrounded: true, task_type: TASK.task_type, session_id: SESSION_ID });
  out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: TOOL, content: `Monitor started (task ${TASK.task_id}, expires in 10m unless the source ends first).` }] } });
  say("ARMED");
  holding = true;
  armed = true;
}

setInterval(() => {
  if (!DIR) return;
  if (waitingArm && existsSync(join(DIR, "arm"))) {
    waitingArm = false;
    arm();
  }
  if (holding && existsSync(join(DIR, "release"))) {
    holding = false;
    finish("ARM-DONE");
  }
  if (armed && !holding && !evented && existsSync(join(DIR, "event"))) {
    evented = true;
    notify(`Monitor event: "${TASK.description}"`, "EVT-LINE-42 build step 3 ok");
    init();
    finish("GOT-EVENT");
  }
  if (armed && !holding && evented && existsSync(join(DIR, "end"))) {
    armed = false;
    out({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: SESSION_ID });
    out({ type: "system", subtype: "task_notification", task_id: TASK.task_id, tool_use_id: TOOL, status: "completed", summary: `Monitor "${TASK.description}" stream ended`, session_id: SESSION_ID });
    notify(`Monitor "${TASK.description}" stream ended`, "EVT-LAST build done");
    init();
    finish("MON-ENDED");
  }
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
    if (text.includes("monwatch-start")) {
      init();
      say("HOLDING");
      waitingArm = true;
    }
    else {
      init();
      finish(`got: ${text.slice(0, 200)}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));

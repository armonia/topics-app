#!/usr/bin/env bun
/**
 * A FAKE CLI THAT STARTS A BACKGROUND BASH THE WAY CLAUDE CODE DOES (BGVIS-09).
 *
 * "bgsrv-listen" runs `$BGSRV_LISTEN`, "bgsrv-build" runs `$BGSRV_BUILD`, each as
 * a background Bash: a real shell, child of this process, that evals the
 * command, the shape measured on Claude Code (`zsh -c … eval '<command>' <
 * /dev/null && pwd -P …`, the command's process its child). Then it prints
 * what Claude Code 2.1.282 prints for one
 * (`tests/fixtures/claude-cli-2.1.282-background-work.ndjson`): the tool call,
 * the `background_tasks_changed` snapshot, the `task_started`, the answer that
 * gives the task's id, and the turn's result.
 *
 * When a shell exits, the snapshot drops its task, the task reports, and the
 * CLI wakes with a turn of its own ("BGSRV-REPORTED"), as the recording shows.
 * The commands stop by themselves once the test's folder is gone.
 */
// A module, not a global script: the other fake CLIs in this folder declare
// the same top-level names, and the typecheck sees them all at once.
export {};

function flagOf(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

/** Two chats run this CLI at once: each process keeps the session the server gave it. */
const SESSION_ID = flagOf("--session-id") ?? flagOf("--resume") ?? crypto.randomUUID();
const JOBS: Record<string, { taskId: string; description: string; command: string }> = {
  "bgsrv-listen": { taskId: "bgsrv1", description: "BGSRV-DEV", command: process.env.BGSRV_LISTEN ?? "" },
  "bgsrv-build": { taskId: "bgbld1", description: "BGSRV-BUILD", command: process.env.BGSRV_BUILD ?? "" },
};
/** The tasks still running, as the snapshot lists them. */
const running = new Map<string, { task_id: string; task_type: string; description: string }>();

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function init(): void {
  out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: SESSION_ID, model: "claude-finto", tools: ["Bash"], fast_mode_state: "off" });
}

function finish(text: string): void {
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text }], model: "claude-finto" } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", session_id: SESSION_ID, result: text, duration_ms: 90, total_cost_usd: 0 });
}

function snapshot(): void {
  out({ type: "system", subtype: "background_tasks_changed", tasks: [...running.values()], session_id: SESSION_ID });
}

function startJob(job: { taskId: string; description: string; command: string }): void {
  const tool = `toolu_${job.taskId}`;
  init();
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "tool_use", id: tool, name: "Bash", input: { command: job.command, description: job.description, run_in_background: true } }], model: "claude-finto" } });
  const shell = Bun.spawn(["/bin/sh", "-c", `eval '${job.command}' < /dev/null && pwd -P >/dev/null`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  running.set(job.taskId, { task_id: job.taskId, task_type: "local_bash", description: job.description });
  snapshot();
  out({ type: "system", subtype: "task_started", task_id: job.taskId, tool_use_id: tool, description: job.description, is_backgrounded: true, task_type: "local_bash", session_id: SESSION_ID });
  out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: `Command running in background with ID: ${job.taskId}. You will be notified when it completes.`, is_error: false }] } });
  finish(`BGSRV-LAUNCHED ${job.description}`);
  void shell.exited.then((code) => {
    running.delete(job.taskId);
    snapshot();
    out({ type: "system", subtype: "task_notification", task_id: job.taskId, tool_use_id: tool, status: "completed", summary: `Background command "${job.description}" completed (exit code ${code})`, session_id: SESSION_ID });
    // The wake: the CLI answers the report with a turn of its own.
    init();
    finish("BGSRV-REPORTED");
  });
}

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
    const job = Object.entries(JOBS).find(([word]) => text.includes(word))?.[1];
    if (job?.command) startJob(job);
    else {
      init();
      finish(`got: ${text.slice(0, 200)}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));

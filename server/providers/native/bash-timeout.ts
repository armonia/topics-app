/**
 * How long a native `bash` call may run (CHAT-NTOOL-07).
 */

/** The deadline of a call that does not ask for one. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/**
 * The longest a native `bash` may run, whatever the model asks: ten minutes.
 * It is the ceiling of Claude Code's own Bash tool, and the same contract on
 * purpose: the models that drive this runtime already ask in those terms
 * (`timeout` 400000, 600000, 900000 in the three days measured on 2026-10-04,
 * when this schema had no `timeout` and every one of them died at 120 s).
 * Past ten minutes a command belongs in the background, where it holds no
 * turn hostage: `run_command` starts it and `wait_for_process` follows it.
 */
export const MAX_BASH_TIMEOUT_MS = 600_000;
/**
 * What the kill of a timed-out `bash` tells the model, so it can do better
 * next time: without it the only move left was `sleep 119` in a loop
 * (topic 5a02dfd5, 2026-10-03), an empty shell on screen for two minutes.
 */
export const BASH_TIMEOUT_HINT =
  `Pass a larger "timeout" (milliseconds, up to ${MAX_BASH_TIMEOUT_MS}), `
  + "or start a longer command with run_command and follow it with wait_for_process.";

/**
 * The deadline of one `bash` call: the model's `timeout` when it is a positive
 * number, capped at `MAX_BASH_TIMEOUT_MS`; otherwise the context's default.
 */
export function resolveBashTimeoutMs(requested: unknown, fallbackMs: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return fallbackMs;
  return Math.min(Math.round(requested), MAX_BASH_TIMEOUT_MS);
}

/** The `bash` tool's description: the deadline is part of the contract the model reads. */
export const BASH_DESCRIPTION =
  "Run a shell command in the workspace. Use it for git, builds, tests, and any tool the machine already has. Output is captured (stdout+stderr) and truncated if huge. Non-interactive only: a command that waits for input will hit the timeout. "
  + `The command is killed after "timeout" milliseconds: ${DEFAULT_BASH_TIMEOUT_MS} by default, at most ${MAX_BASH_TIMEOUT_MS}. `
  + "For anything longer, start it with run_command and follow it with wait_for_process.";

/** The `timeout` field of the `bash` input schema. */
export const BASH_TIMEOUT_PROPERTY = {
  type: "number",
  description: `Milliseconds before the command is killed. Default ${DEFAULT_BASH_TIMEOUT_MS}, maximum ${MAX_BASH_TIMEOUT_MS}: a larger value is capped.`,
};

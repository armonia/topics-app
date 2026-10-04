#!/usr/bin/env bun
/**
 * A FAKE `codex exec --json` WHOSE COMMAND PRINTS THREE LINES AND GOES QUIET.
 *
 * One turn: a line of text, a `bash` tool call (`bun test`), one
 * `item.updated` with `aggregated_output` "r1\nr2\nr3" (the provider hands it
 * to `onToolUpdate`, the path a real running shell takes), then
 * `FAKE_CODEX_SILENCE` seconds of nothing (default 150), then the result and
 * "FAKE-CODEX-DONE". `--version` answers and exits, as the real binary does.
 */

// A module, not a global script: the other fakes in this folder declare the
// same top-level names, and the typecheck sees them all at once.
export {};

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-e2e\n");
  process.exit(0);
}

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

// The prompt arrives on stdin: read and dropped, so the writer never blocks.
process.stdin.on("data", () => {});

const silence = Number(process.env.FAKE_CODEX_SILENCE ?? 150) * 1000;
out({ type: "thread.started", thread_id: "fake-codex-running-tail" });
out({ type: "turn.started" });
out({ type: "item.completed", item: { id: "msg0", type: "agent_message", text: "Running the tests." } });
out({ type: "item.started", item: { id: "tailcmd1", type: "tool_call", name: "bash", arguments: { command: "bun test" } } });
setTimeout(() => {
  out({ type: "item.updated", item: { id: "tailcmd1", type: "tool_call", name: "bash", aggregated_output: "r1\nr2\nr3\n" } });
  setTimeout(() => {
    out({ type: "item.completed", item: { id: "tailcmd1", type: "tool_call", name: "bash", aggregated_output: "r1\nr2\nr3\n3 pass\n", exit_code: 0 } });
    out({ type: "item.completed", item: { id: "msg1", type: "agent_message", text: "FAKE-CODEX-DONE" } });
    out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
    process.exit(0);
  }, silence);
}, 1_000);

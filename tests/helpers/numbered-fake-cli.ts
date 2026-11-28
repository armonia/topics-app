/**
 * A FAKE `claude` CLI THAT COUNTS, PACED BY AN IN-PROCESS TIMER.
 *
 * Two tests (late-scan-route-grace, claude-code-live-mark) fed the daemon a
 * shell loop: `printf` a numbered line, `sleep 0.02`, 400 times. That pacing is
 * the cost of 400 forks of `sleep`, and on a loaded Mac one `sleep 0.02` took
 * ~110 ms (measured: 400 of them, 50 s instead of 8 s). The turn then outlived
 * the window the test waits in, and both went red on main, from a checkout that
 * had nothing to do with it. A timer inside one process keeps its pace (50 sleeps
 * of 20 ms measured 1.09 s on the same machine), so the turn lasts what the test
 * says it lasts.
 *
 * Behaviour of the script it writes: for each line read on stdin it prints
 * `count` assistant lines whose text is `<n>,` every `intervalMs`, then the
 * `result` line. SIGINT ends it with exit 0, as the real CLI does in stream-json mode.
 */
import { chmodSync, writeFileSync } from "node:fs";

export interface NumberedCliOptions {
  count: number;
  intervalMs: number;
  /** The `result` line printed when the numbers are done (a JSON object as text). */
  result: string;
}

/** Writes an executable CLI at `path` and returns it. */
export function writeNumberedCli(path: string, opts: NumberedCliOptions): string {
  const body = `process.on("SIGINT", () => process.exit(0));
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let lineEnd;
  while ((lineEnd = buffer.indexOf("\\n")) !== -1) {
    buffer = buffer.slice(lineEnd + 1);
    for (let i = 1; i <= ${opts.count}; i++) {
      process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: i + "," }] } }) + "\\n");
      await Bun.sleep(${opts.intervalMs});
    }
    process.stdout.write(${JSON.stringify(opts.result)} + "\\n");
  }
}
`;
  const script = `${path}.mjs`;
  writeFileSync(script, body);
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`);
  chmodSync(path, 0o755);
  return path;
}

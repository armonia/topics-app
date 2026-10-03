#!/usr/bin/env bun
/**
 * A FAKE CLI THAT WRITES DOWN EXACTLY WHAT IT WAS HANDED: its argv once, then
 * every stdin line verbatim, one JSON line each, to the file named by
 * `FAKE_CLI_LOG`:
 *
 *   {"event":"argv","argv":[...]}
 *   {"event":"stdin","line":"<the raw NDJSON line>"}
 *
 * Every user message gets a one-turn answer ("got"), so the provider settles.
 * It exists to see the SHAPE of a user message on the wire (a string, or text
 * blocks), which the other fakes flatten before logging.
 */
export {};
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("claude 2.1.288-e2e-record-input\n");
  process.exit(0);
}

const LOG = process.env.FAKE_CLI_LOG;
const note = (o: Record<string, unknown>) => { if (LOG) appendFileSync(LOG, JSON.stringify(o) + "\n"); };

if (flag("--output-format") === "json") {
  process.stdin.on("data", () => {});
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Titolo" }) + "\n");
    process.exit(0);
  }, 50);
} else if (flag("--input-format") !== "stream-json") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else {
  note({ event: "argv", argv });
  const sessionId = flag("--session-id") ?? flag("--resume") ?? crypto.randomUUID();
  const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + "\n");
  let seq = 0;
  let pending = "";
  process.stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      note({ event: "stdin", line });
      let type: unknown;
      try { type = (JSON.parse(line) as { type?: unknown }).type; } catch { continue; }
      if (type !== "user") continue;
      out({ type: "system", subtype: "init", model: "claude-finto", tools: [], fast_mode_state: "off", cwd: process.cwd() });
      out({ type: "assistant", message: { id: `msg_${++seq}`, role: "assistant", model: "claude-finto", content: [{ type: "text", text: "got" }], usage: { input_tokens: 10, output_tokens: 1 } } });
      out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", result: "got", duration_ms: 5, total_cost_usd: 0 });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => setTimeout(() => process.exit(0), 50));
}

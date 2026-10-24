#!/usr/bin/env bun
/**
 * A FAKE CLAUDE CLI THAT KEEPS ITS TRANSCRIPT the way the real one does, for a
 * test that restarts the server under a chat.
 *
 * - `--session-id <id>` starts a session; `--resume <id>` reopens one and,
 *   exactly like the real CLI, fails with "No conversation found with session
 *   ID" (exit 1) when `~/.claude/projects/<encoded cwd>/<id>.jsonl` is gone.
 * - Every user message is appended to that file, then answered with
 *   `remembers:<n>`, where n is how many user messages the transcript holds
 *   before this one: the model's memory, as far as a test can see it.
 * - "SLOW:<ms>" in a message holds the answer for <ms>, so a restart can land
 *   while the turn is under way.
 * - Every start writes its argv as one JSON line to `FAKE_CLI_ARGV_LOG`.
 *
 * `--version` answers; a one-shot (`--output-format json`, the auto-namer)
 * prints a title and exits.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("claude 2.1.300-transcript-fake\n");
  process.exit(0);
}
if (process.env.FAKE_CLI_ARGV_LOG) appendFileSync(process.env.FAKE_CLI_ARGV_LOG, JSON.stringify(argv) + "\n");

if (flag("--output-format") === "json") {
  process.stdin.on("data", () => {});
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"title": "Titolo"}' }) + "\n");
    process.exit(0);
  }, 50);
} else if (flag("--input-format") !== "stream-json") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else {
  const resumed = flag("--resume");
  const sessionId = resumed ?? flag("--session-id") ?? crypto.randomUUID();
  const dir = join(process.env.HOME || homedir(), ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
  const transcript = join(dir, `${sessionId}.jsonl`);
  if (resumed && !existsSync(transcript)) {
    process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });

  const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + "\n");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let seq = 0;
  const userLines = () =>
    existsSync(transcript) ? readFileSync(transcript, "utf8").split("\n").filter((l) => l.includes('"type":"user"')).length : 0;

  function textOf(line: string): string | null {
    try {
      const o = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (o.type !== "user") return null;
      const c = o.message?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : "")).join("");
    } catch { /* not JSON */ }
    return null;
  }

  let queue: Promise<void> = Promise.resolve();
  let pending = "";
  process.stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      const asked = textOf(line);
      if (asked === null) continue;
      queue = queue.then(async () => {
        const before = userLines();
        appendFileSync(transcript, JSON.stringify({ type: "user", sessionId, text: asked }) + "\n");
        out({ type: "system", subtype: "init", model: "claude-finto", tools: [], fast_mode_state: "off", cwd: process.cwd() });
        const slow = /SLOW:(\d+)/.exec(asked);
        if (slow) await sleep(Number(slow[1]));
        const answer = `remembers:${before}`;
        appendFileSync(transcript, JSON.stringify({ type: "assistant", sessionId, text: answer }) + "\n");
        out({ type: "assistant", message: { id: `msg_${++seq}`, role: "assistant", model: "claude-finto", content: [{ type: "text", text: answer }], usage: { input_tokens: 10, output_tokens: 4 } } });
        out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", result: answer, duration_ms: 50, total_cost_usd: 0 });
      });
    }
  });
  process.stdin.on("end", () => { void queue.then(() => process.exit(0)); });
  process.on("SIGTERM", () => process.exit(0));
}

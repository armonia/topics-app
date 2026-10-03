#!/usr/bin/env bun
/**
 * A FAKE CLI THAT REPLAYS LINES RECORDED FROM THE REAL ONE (Claude Code
 * 2.1.288, `server/providers/claude/fixtures/command-lines-2.1.288.json`), for
 * the specs of the commands (CMDUI-01..07).
 *
 * What it plays, as the real CLI wrote it when driven with Topics' flags:
 *   - `system/init` with `slash_commands` (the CLI's own names, plus `vai` and  allow-italian: skill name
 *     `recap`), on every turn, with the cwd it runs in;
 *   - `system/commands_changed` with descriptions and the `builtin` flag,
 *     after the first ordinary turn;
 *   - the answer of a LOCAL command: `/output-style` answers with its
 *     recorded `<synthetic>` message and a `result` with `num_turns: 0`;
 *   - `/compact`: on a session with no turn yet the recorded failure
 *     (`system/status` with `compact_result: "failed"`, the `<synthetic>`
 *     «Not enough messages to compact.», `num_turns: 0`), after a turn a
 *     `compact_boundary` and an empty `result`.
 * Anything else is answered «got: <last line>» as a turn of the model.
 *
 * It writes to `FAKE_CLI_LOG`, one JSON line per event: its start arguments
 * (`{"event":"start","argv":[...]}`, so a spec can read `--resume <id>`) and
 * every message it is handed (`{"event":"received","text":...}`).
 *
 * WHAT IT CANNOT SHOW: a real compaction, a real `/clear`, the real expansion
 * of a skill, the substitution of `$ARGUMENTS` in its body, or anything the
 * model would answer. Those are the real CLI's, measured on it.
 */
export {};
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("claude 2.1.288-e2e-replay\n");
  process.exit(0);
}

const LOG = process.env.FAKE_CLI_LOG;
const note = (o: Record<string, unknown>) => { if (LOG) appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + "\n"); };

const RECORDED = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "server", "providers", "claude", "fixtures", "command-lines-2.1.288.json"), "utf8"),
) as Record<string, Record<string, unknown>>;

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
  note({ event: "start", argv });
  const sessionId = flag("--session-id") ?? flag("--resume") ?? crypto.randomUUID();
  const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + "\n");
  let seq = 0;
  let turns = 0;
  let saidCommands = false;

  const init = () => out({ ...RECORDED.init, cwd: process.cwd(), tools: [], fast_mode_state: "off" });
  const text = (value: string) =>
    out({ type: "assistant", message: { id: `msg_${++seq}`, role: "assistant", model: "claude-finto", content: [{ type: "text", text: value }], usage: { input_tokens: 10, output_tokens: 4 } } });
  const result = (value: string, numTurns: number) =>
    out({ type: "result", subtype: "success", is_error: false, num_turns: numTurns, stop_reason: numTurns ? "end_turn" : null, result: value, duration_ms: 40, total_cost_usd: 0 });
  const synthetic = (value: string) =>
    out({ type: "assistant", message: { id: crypto.randomUUID(), role: "assistant", model: "<synthetic>", type: "message", content: [{ type: "text", text: value }], usage: { input_tokens: 0, output_tokens: 0 } } });

  /** `lastBlock`: the CLI reads a command from the LAST text block (the context may ride in one before it). */
  function answer(asked: string, lastBlock: string): void {
    const command = lastBlock.trim().split(/\s/, 1)[0];
    init();
    if (command === "/output-style") {
      const recorded = RECORDED.outputStyleSynthetic as { message: { content: Array<{ text: string }> } };
      const said = recorded.message.content.map((b) => b.text).join("");
      synthetic(said);
      result(said, 0);
      return;
    }
    if (command === "/compact") {
      if (turns === 0) {
        out({ type: "system", subtype: "status", status: "compacting" });
        out({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Not enough messages to compact." });
        synthetic("Not enough messages to compact.");
        result("Not enough messages to compact.", 0);
      } else {
        out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 52_000 } });
        result("", 0);
      }
      return;
    }
    turns++;
    // The message itself is the last line: the context Topics adds rides before it.
    const reply = `got: ${(lastBlock.trim().split("\n").at(-1) ?? asked).slice(-120)}`;
    text(reply);
    result(reply, 1);
    if (!saidCommands) {
      saidCommands = true;
      out({ ...RECORDED.commandsChanged });
    }
  }

  /** The whole text of a message, and its last text block. */
  function textOf(line: string): { all: string; last: string } | null {
    try {
      const o = JSON.parse(line) as { message?: { content?: unknown } };
      const c = o?.message?.content;
      if (typeof c === "string") return { all: c, last: c };
      if (Array.isArray(c)) {
        const texts = c.map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : "")).filter(Boolean);
        return { all: texts.join(""), last: texts[texts.length - 1] ?? "" };
      }
    } catch { /* not JSON */ }
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
      const asked = textOf(line);
      if (asked === null) continue;
      note({ event: "received", text: asked.all.slice(-600), last: asked.last.slice(0, 600) });
      answer(asked.all, asked.last);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => { setTimeout(() => process.exit(0), 300); });
}

#!/usr/bin/env bun
/**
 * A FAKE CLI THAT SAYS WHEN IT WAS HANDED EACH MESSAGE, AND WHETHER A TURN WAS
 * RUNNING AT THAT MOMENT.
 *
 * The question behind it (CHAT-QUEUE-07): a message typed while a turn runs must
 * reach the CLI only after that turn's `result`. The real CLI accepts a line on
 * stdin mid-turn and injects it at the next tool boundary, so "the model saw it
 * mid-turn" is invisible from the chat; this fake writes it down instead, one
 * JSON line per event, to the file named by `FAKE_CLI_LOG`:
 *
 *   {"at":<ms>,"event":"received","text":"...","busy":true|false}
 *   {"at":<ms>,"event":"turn-start"|"turn-end","tag":"..."}
 *
 * What a message asks for decides the turn:
 *
 *   "LONGTURN:<n>:<ms>:<tag>"  n rounds of a text and a Bash call with its
 *                      result, <ms> apart, then the result: a turn of several
 *                      assistant messages and tool calls.
 *   "WAKE:<delay>:<n>:<ms>:<tag>"  answers "armed" at once; <delay> ms later the
 *                      CLI opens a turn BY ITSELF, the way a background task's
 *                      report does (task_notification, init, rounds, result),
 *                      and like the real one it is silent for <ms> between its
 *                      init and its first line (measured p50 4.7 s).
 *   "SLOWINIT:<ms>:<tag>"  a turn whose `system/init` comes <ms> late, as a
 *                      child spawned cold does, then a line every 700 ms until
 *                      the CLI is stopped (SIGINT, logged as "sigint").
 *   "PLANTURN:<ms>:<tag>"  a turn that, <ms> after its first line, ends on an
 *                      `ExitPlanMode` with no result:
 *                      in a topic with autonomy `ask`, Topics turns it into a
 *                      plan approval for the person.
 *   "SIGINTEXIT:<ms>"  anywhere in a message: from then on the child exits
 *                      <ms> after a SIGINT instead of 300 ms (the real one took
 *                      6-7 s under load, production 29/09).
 *   anything else      "got: <text>", at once.
 *
 * Like the real CLI it never answers two turns at once: a line received during
 * a turn is answered after it (the real one merges it into the running turn;
 * `busy: true` in the log is that case).
 */
export {};
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("claude 2.1.280-e2e-queue-turns\n");
  process.exit(0);
}

const LOG = process.env.FAKE_CLI_LOG;
const note = (o: Record<string, unknown>) => { if (LOG) appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + "\n"); };

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
  const sessionId = flag("--session-id") ?? flag("--resume") ?? crypto.randomUUID();
  const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + "\n");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let seq = 0;
  let busy = false;
  let interruptExitMs = 300;

  const init = () => out({ type: "system", subtype: "init", model: "claude-finto", tools: [], fast_mode_state: "off", cwd: process.cwd() });
  const text = (value: string) =>
    out({ type: "assistant", message: { id: `msg_${++seq}`, role: "assistant", model: "claude-finto", content: [{ type: "text", text: value }], usage: { input_tokens: 10, output_tokens: 4 } } });
  const result = (value: string) =>
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", result: value, duration_ms: 50, total_cost_usd: 0 });

  /** One turn, start to `result`, with the boundaries in the log. */
  async function turn(tag: string, body: () => Promise<string>): Promise<void> {
    busy = true;
    note({ event: "turn-start", tag });
    init();
    const said = await body();
    note({ event: "turn-end", tag });
    busy = false;
    result(said);
  }

  async function rounds(n: number, ms: number, tag: string): Promise<string> {
    let all = "";
    for (let i = 1; i <= n; i++) {
      const piece = `${tag} round ${i}. `;
      all += piece;
      text(piece);
      await sleep(ms);
      const toolId = `toolu_${tag}_${++seq}`;
      out({ type: "assistant", message: { id: `msg_${++seq}`, role: "assistant", model: "claude-finto", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: `echo ${tag}-${i}` } }], usage: { input_tokens: 10, output_tokens: 4 } } });
      await sleep(Math.min(ms, 300));
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `${tag}-${i}`, is_error: false }] } });
      await sleep(ms);
    }
    const end = `${tag} END.`;
    text(end);
    return all + end;
  }

  function textOf(line: string): string | null {
    try {
      const o = JSON.parse(line) as { message?: { content?: unknown } };
      const c = o?.message?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : "")).join("");
    } catch { /* not JSON */ }
    return null;
  }

  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => { queue = queue.then(work, work); };
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
      // The whole message, context preamble included: the test looks for its tag.
      note({ event: "received", text: asked.slice(-400), busy });
      const exitAfter = /SIGINTEXIT:(\d+)/.exec(asked);
      if (exitAfter) interruptExitMs = Number(exitAfter[1]);
      const slow = /SLOWINIT:(\d+):([A-Za-z0-9]+)/.exec(asked);
      const plan = /PLANTURN:(\d+):([A-Za-z0-9]+)/.exec(asked);
      if (slow) {
        const ms = slow[1]!;
        const tag = slow[2]!;
        enqueue(async () => {
          busy = true;
          note({ event: "turn-start", tag });
          await sleep(Number(ms));
          init();
          for (let i = 1; i <= 200; i++) { text(`${tag} tick ${i}. `); await sleep(700); }
          note({ event: "turn-end", tag });
          busy = false;
          result(`${tag} END.`);
        });
        continue;
      }
      if (plan) {
        const ms = plan[1]!;
        const tag = plan[2]!;
        enqueue(() => turn(tag, async () => {
          text(`${tag} planning. `);
          await sleep(Number(ms));
          out({ type: "assistant", message: { id: `msg_${++seq}`, role: "assistant", model: "claude-finto", content: [{ type: "tool_use", id: `toolu_plan_${++seq}`, name: "ExitPlanMode", input: { plan: "# Plan\n\n1. Read the files\n2. Write the code" } }], usage: { input_tokens: 10, output_tokens: 4 } } });
          await sleep(200);
          return `${tag} planning. `;
        }));
        continue;
      }
      const long = /LONGTURN:(\d+):(\d+):([A-Za-z0-9]+)/.exec(asked);
      const wake = /WAKE:(\d+):(\d+):(\d+):([A-Za-z0-9]+)/.exec(asked);
      if (long) {
        enqueue(() => turn(long[3]!, () => rounds(Number(long[1]), Number(long[2]), long[3]!)));
      } else if (wake) {
        enqueue(() => turn("arm", async () => { text("armed"); return "armed"; }));
        const [, delay, n, ms, tag] = wake;
        setTimeout(() => enqueue(async () => {
          out({ type: "system", subtype: "task_notification", task_id: `task_${tag}`, status: "completed", summary: `${tag} finished` });
          await turn(tag!, async () => { await sleep(Number(ms)); return rounds(Number(n), Number(ms), tag!); });
        }), Number(delay));
      } else {
        const reply = `got: ${asked.slice(-120)}`;
        enqueue(() => turn("reply", async () => { text(reply); return reply; }));
      }
    }
  });
  process.stdin.on("end", () => { void queue.then(() => process.exit(0)); });
  process.on("SIGTERM", () => process.exit(0));
  // Like the real one in stream-json mode: a SIGINT ends the turn and the child.
  process.on("SIGINT", () => { note({ event: "sigint", busy }); setTimeout(() => process.exit(0), interruptExitMs); });
}

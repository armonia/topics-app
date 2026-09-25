#!/usr/bin/env bun
/**
 * A FAKE CLI WHOSE TURN TAKES SECONDS, so a test can do things to a window while
 * the turn is in flight: move the focus, open the chat, drop the socket,
 * restart the server.
 *
 * Speaks the stream-json dialect the chat runtime drives, one persistent
 * process per session. What a message asks for decides the turn:
 *
 *   "TOOLTURN:<ms>"    "START of the answer.", a Bash call and its result,
 *                      "MIDDLE of the answer.", "END of the answer.", with
 *                      <ms> between the pieces. The shape of a real agent turn:
 *                      text, a tool, more text.
 *   "SLOW:<n>:<tag>"   n text chunks `<tag>-01 ` .. `<tag>-NN `, one a second.
 *                      A window that shows the turn must show them as a
 *                      contiguous prefix, whenever it looks.
 *   anything else      "ok", at once.
 *
 * `--version` answers and exits 0; a one-shot (`--output-format json`, the
 * auto-namer) prints one result; an interactive PTY (no stream-json input)
 * stays alive until it is killed. Installed for one spec at a time by
 * `fake-claude-cli.ts`.
 */
export {};

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("claude 2.1.280-e2e-slow-turn\n");
  process.exit(0);
}

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

  const init = () => out({ type: "system", subtype: "init", model: "claude-finto", tools: [], fast_mode_state: "off", cwd: process.cwd() });
  const text = (value: string) =>
    out({ type: "assistant", message: { id: `msg_${++seq}`, role: "assistant", model: "claude-finto", content: [{ type: "text", text: value }], usage: { input_tokens: 10, output_tokens: 4 } } });
  const result = (value: string) =>
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", result: value, duration_ms: 50, total_cost_usd: 0 });

  async function toolTurn(step: number): Promise<void> {
    const pieces = ["START of the answer. ", "MIDDLE of the answer. ", "END of the answer."];
    text(pieces[0]!);
    await sleep(step);
    const toolId = `toolu_slow_${++seq}`;
    out({ type: "assistant", message: { id: `msg_${++seq}`, role: "assistant", model: "claude-finto", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "echo tool-visible" } }], usage: { input_tokens: 10, output_tokens: 4 } } });
    await sleep(300);
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "tool-visible", is_error: false }] } });
    await sleep(step);
    text(pieces[1]!);
    await sleep(step);
    text(pieces[2]!);
    result(pieces.join(""));
  }

  async function slowTurn(n: number, tag: string): Promise<void> {
    let all = "";
    for (let i = 1; i <= n; i++) {
      const chunk = `${tag}-${String(i).padStart(2, "0")} `;
      all += chunk;
      text(chunk);
      await sleep(1000);
    }
    result(all);
  }

  /** The text of a user message line, or null for anything else. */
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
        init();
        const tool = /TOOLTURN:(\d+)/.exec(asked);
        const slow = /SLOW:(\d+):([A-Za-z0-9]+)/.exec(asked);
        if (tool) await toolTurn(Number(tool[1]));
        else if (slow) await slowTurn(Number(slow[1]), slow[2]!);
        else {
          text("ok");
          result("ok");
        }
      });
    }
  });
  process.stdin.on("end", () => { void queue.then(() => process.exit(0)); });
  process.on("SIGTERM", () => process.exit(0));
}

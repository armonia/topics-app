/**
 * A LONG COMMAND SHOWS ITS OUTPUT WHILE IT RUNS.
 *
 * Tool UX review of 23/09, finding 7: a native `bash` at p90 lasts 65-115 s, and
 * for all that time the row showed a spinner and `$ command`, nothing else. The
 * native runtime is the default one, and it was the only runtime with output
 * that sent none: `runCommand` kept stdout/stderr in `out` and handed it back
 * only at the close, `ToolContext` had no progress hook, and the agent loop
 * called `executeTool` without one. Codex, acp and openclaw already stream their
 * partial output through `handler.onToolUpdate`.
 *
 * What is pinned here is the contract of the new hook: the WHOLE current tail on
 * every call (the client replaces `result`, it does not append), taken from a
 * buffer of its own so a verbose command does not freeze it, at most one call
 * every 250 ms, nothing after the answer, and a callback that throws cannot
 * change the tool's outcome. The last block drives the agent loop itself, to
 * prove the hook reaches `onToolUpdate` under the id of the call.
 *
 * @covers CHAT-NTOOL-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { executeTool } from "./tools";
import { runAgentTurn } from "./agent-loop";
import type { StreamHandler } from "../types";
import type { RetryPolicy } from "./retry";

const workspace = process.cwd();

function recorder() {
  const calls: string[] = [];
  return { calls, onOutput: (tail: string) => { calls.push(tail); } };
}

describe("the native bash streams its tail while it runs", () => {
  test("a slow command is visible while it runs, and its answer does not change", async () => {
    const command = "for i in 1 2 3; do echo L$i; sleep 0.4; done";
    const seen = recorder();
    const live = await executeTool("bash", { command }, { workspace, onOutput: seen.onOutput });
    // Counted when the promise resolved: these calls arrived while it ran.
    expect(seen.calls.length).toBeGreaterThanOrEqual(2);
    expect(seen.calls.some((tail) => tail.includes("L1") && !tail.includes("L3"))).toBe(true);
    const plain = await executeTool("bash", { command }, { workspace });
    expect(live).toEqual(plain);
  });

  test("a verbose command does not freeze the tail", async () => {
    // About 109 KB, past the 60 000 characters where `out` stops growing: a tail
    // cut from `out` would stand still halfway through the sequence.
    const seen = recorder();
    await executeTool("bash", { command: "seq 1 20000; sleep 1" }, { workspace, onOutput: seen.onOutput });
    const tail = seen.calls.at(-1);
    expect(tail).toBeDefined();
    const lines = tail!.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("20000");
    expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(16 * 1024);
    // It starts at a line start: the first line is a whole number, the one
    // before the second. A cut inside `19234` would read `234`, and 234 + 1 is
    // not 19235.
    expect(Number(lines[1])).toBe(Number(lines[0]) + 1);
  });

  test("nothing arrives after the answer", async () => {
    // Output without pause for one second of wall time, then exit. The bound is
    // the clock, not a count of sleeps, so a loaded machine cannot stretch it.
    const command = `perl -MTime::HiRes=time,sleep -e '$|=1; my $end = time + 1; while (time < $end) { print "tick\\n"; sleep 0.02 }'`;
    const seen = recorder();
    const out = await executeTool("bash", { command }, { workspace, onOutput: seen.onOutput });
    expect(out.content).toContain("tick");
    const atAnswer = seen.calls.length;
    // It did stream, or the silence below would prove nothing.
    expect(atAnswer).toBeGreaterThan(0);
    await Bun.sleep(500);
    expect(seen.calls.length).toBe(atAnswer);
    expect(atAnswer).toBeLessThanOrEqual(5);
  });

  test("a broken callback does not break the tool", async () => {
    // The command lasts past the first window on purpose: with a bare `echo ok`
    // the callback would never be reached and the test could not fail.
    let thrown = 0;
    const out = await executeTool("bash", { command: "echo ok; sleep 0.4" }, {
      workspace,
      onOutput: () => { thrown++; throw new Error("the watcher went away"); },
    });
    expect(thrown).toBeGreaterThan(0);
    expect(out).toEqual({ content: "ok" });
  });
});

// ── The loop wires it to the handler ─────────────────────────────────────────

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
let homeDir = "";
const FAST: RetryPolicy = { maxAttempts: 2, baseMs: 1, capMs: 2, jitter: () => 1 };

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const bashRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "bash", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "for i in 1 2 3; do echo L$i; sleep 0.4; done" }) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
]);

const lastRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

describe("the agent loop hands the tail to onToolUpdate", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-tail-home-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "token-A", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = homeDir;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("a bash of the turn streams under its own call id, before its result", async () => {
    const events: Array<[string, string, string]> = [];
    let n = 0;
    globalThis.fetch = (async () => new Response([bashRound, lastRound][Math.min(n++, 1)]!, { status: 200 })) as unknown as typeof fetch;
    const handler: StreamHandler = {
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolUpdate: (id, partial) => { events.push(["update", id, partial]); },
      onToolResult: (id, result) => { events.push(["result", id, result]); },
      onDone: () => {},
      onError: () => {},
      onAborted: () => {},
    };
    await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history: [{ role: "user", content: "run it" }],
        toolContext: { workspace },
        autonomy: "auto-apply",
        retryPolicy: FAST,
      },
      handler,
    );
    const updates = events.filter(([kind]) => kind === "update");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(([, id]) => id === "t1")).toBe(true);
    expect(updates[0]![2]).toContain("L1");
    // The answer closes the stream: no partial lands after it.
    expect(events.at(-1)![0]).toBe("result");
  });
});

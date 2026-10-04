/**
 * What the native loop tells the route about a call before it runs it.
 *
 * Two facts the row on screen is built from: the primary argument goes out
 * while the model is still writing the call (marked partial), and the calls of
 * one round START one after the other, each `onToolExecStart` after the
 * previous call's result. The route turns the second fact into `pending` ->
 * `running`; the end-to-end proof is `tests/e2e/chat-native-tool-phases.spec.ts`.
 *
 * @covers CHAT-NTOOL-05
 * @covers CHAT-NTOOL-06
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn } from "./agent-loop";
import type { StreamHandler } from "../types";
import type { RetryPolicy } from "./retry";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
let homeDir = "";
const FAST: RetryPolicy = { maxAttempts: 2, baseMs: 1, capMs: 2, jitter: () => 1 };

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** A tool_use block whose input arrives in `pieces` fragments. */
function toolBlock(index: number, id: string, input: Record<string, unknown>, pieces: number): unknown[] {
  const json = JSON.stringify(input);
  const size = Math.ceil(json.length / pieces);
  const deltas = Array.from({ length: pieces }, (_, p) => ({
    type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(p * size, (p + 1) * size) },
  }));
  return [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "bash", input: {} } },
    ...deltas,
    { type: "content_block_stop", index },
  ];
}

const pairRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  ...toolBlock(0, "t1", { command: "echo first; sleep 0.3" }, 2),
  ...toolBlock(1, "t2", { command: "echo second" }, 1),
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
]);

const lastRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

describe("native tool phases", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-phases-home-"));
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

  test("partial args while written, then each call starts after the previous result", async () => {
    const events: string[] = [];
    const partials: Array<{ id: string; args: Record<string, unknown> }> = [];
    let n = 0;
    globalThis.fetch = (async () => new Response([pairRound, lastRound][Math.min(n++, 1)]!, { status: 200 })) as unknown as typeof fetch;
    const handler: StreamHandler = {
      onTextDelta: () => {},
      onToolStart: (id) => { events.push(`announce:${id}`); },
      onToolArgsUpdate: (id, args, update) => {
        if (update?.partial) partials.push({ id, args: args as Record<string, unknown> });
        else events.push(`args:${id}`);
      },
      onToolExecStart: (id) => { events.push(`start:${id}`); },
      onToolResult: (id) => { events.push(`result:${id}`); },
      onDone: () => {},
      onError: () => {},
      onAborted: () => {},
    };
    await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history: [{ role: "user", content: "run both" }],
        toolContext: { workspace: process.cwd() },
        autonomy: "auto-apply",
        retryPolicy: FAST,
      },
      handler,
    );

    // The first fragment already names the command, open value and all.
    expect(partials.length).toBeGreaterThan(0);
    expect(partials[0]!.id).toBe("t1");
    const first = String(partials[0]!.args.command);
    expect(first.length).toBeGreaterThan(0);
    expect("echo first; sleep 0.3".startsWith(first)).toBe(true);

    // Both are announced and complete before either runs; t2 starts after t1's result.
    expect(events).toEqual([
      "announce:t1", "args:t1", "announce:t2", "args:t2",
      "start:t1", "result:t1", "start:t2", "result:t2",
    ]);
  });
});

/**
 * THE USER'S PRE-TOOL HOOK SPEAKS AFTER THE PERMISSION, THROUGH THE SAME DOOR.
 *
 * Driven against a fake `fetch` like `agent-loop-retry.test.ts`: the first
 * scripted round asks for a `bash` tool call, the second closes the turn. What
 * is asserted is the pair the spec names: the tool result carries the hook's
 * stderr and is marked as an error, AND the command never ran (the file it
 * would have written does not exist). The control test runs the same script
 * with no `hooks` at all and proves the round is what it was before hooks
 * existed: the command runs, the result is not an error, and the second
 * request the model receives is byte-identical to the one an allowing hook
 * produces.
 * @covers HOOKS-02
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";
import type { RetryPolicy } from "./retry";
import type { LifecycleHookRunner, LifecycleHookPayload } from "../../services/lifecycle-hooks";

const REAL_HOME = process.env.HOME;
let homeDir: string;
let ws: string;
const realFetch = globalThis.fetch;

const FAST: RetryPolicy = { maxAttempts: 2, baseMs: 1, capMs: 2, jitter: () => 1 };

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const MARKER = "hook-was-not-here.txt";

/** Round one: the model asks for `bash` writing a marker file in the workspace. */
function bashRound(): string {
  const input = JSON.stringify({ command: `echo touched > ${MARKER}` });
  return sse([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "bash", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  ]);
}

const lastRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

interface Ledger {
  toolResults: Array<[string, string, boolean | undefined]>;
  bodies: string[];
  done: number;
  errors: string[];
}

function handler(reg: Ledger): StreamHandler {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: (id, result, isError) => { reg.toolResults.push([id, result, isError]); },
    onDone: () => { reg.done++; },
    onError: (e: string) => { reg.errors.push(e); },
    onAborted: () => {},
  };
}

function scriptFetch(answers: string[], reg: Ledger) {
  let n = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    reg.bodies.push(String(init?.body ?? ""));
    const body = answers[Math.min(n++, answers.length - 1)]!;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

function fresh(): Ledger {
  return { toolResults: [], bodies: [], done: 0, errors: [] };
}

async function turn(reg: Ledger, hooks?: LifecycleHookRunner) {
  const history: AgentMessage[] = [{ role: "user", content: "scrivi il marker" }];
  return runAgentTurn(
    {
      model: "claude-haiku-4-5-20251001",
      history,
      toolContext: { workspace: ws },
      autonomy: "auto-apply",
      retryPolicy: FAST,
      ...(hooks ? { hooks, sessionId: "sess-1" } : {}),
    },
    handler(reg),
  );
}

describe("the pre-tool hook in the native loop", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-hooks-home-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "token-A", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = homeDir;
  });

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "native-hooks-ws-"));
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("a hook that refuses bash: the tool result is its stderr, marked as an error, and the command did not run", async () => {
    const reg = fresh();
    const seen: Array<[string, LifecycleHookPayload]> = [];
    const hooks: LifecycleHookRunner = {
      run: async (event, payload) => {
        seen.push([event, payload]);
        return { ok: false, reason: "no bash on fridays" };
      },
    };
    scriptFetch([bashRound(), lastRound], reg);
    const out = await turn(reg, hooks);

    expect(reg.toolResults).toEqual([["t1", "no bash on fridays", true]]);
    expect(existsSync(join(ws, MARKER))).toBe(false);
    // What the hook read: the event, the session, the workspace as cwd, the call.
    expect(seen).toEqual([["pre-tool", {
      hook_event_name: "pre-tool",
      session_id: "sess-1",
      cwd: ws,
      tool_name: "bash",
      tool_input: { command: `echo touched > ${MARKER}` },
    }]]);
    // The turn goes on: the refusal is a result the model reads, not a death.
    expect(out.turnEnd.end).toBe("end_turn");
    expect(reg.done).toBe(1);
    expect(reg.errors).toEqual([]);
    // The history carries the refusal as an error result, like a denied permission.
    const body = JSON.parse(reg.bodies[1]!);
    const results = body.messages.at(-1).content;
    // `toMatchObject`: the prompt-cache breakpoint rides on the last block
    // and is not part of this claim.
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "no bash on fridays", is_error: true });
  });

  test("without `hooks` the round is what it was: the command runs and the result is not an error", async () => {
    const reg = fresh();
    scriptFetch([bashRound(), lastRound], reg);
    await turn(reg);

    expect(existsSync(join(ws, MARKER))).toBe(true);
    expect(reg.toolResults).toHaveLength(1);
    expect(reg.toolResults[0]![0]).toBe("t1");
    expect(reg.toolResults[0]![2]).toBeFalsy();

    // And an allowing hook changes nothing either: the second request the
    // model receives is byte-identical between the two runs.
    const control = fresh();
    ws = mkdtempSync(join(tmpdir(), "native-hooks-ws-"));
    scriptFetch([bashRound(), lastRound], control);
    await turn(control, { run: async () => ({ ok: true }) });
    expect(existsSync(join(ws, MARKER))).toBe(true);
    expect(control.bodies[1]).toBe(reg.bodies[1]);
  });
});

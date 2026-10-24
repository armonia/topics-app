/**
 * The prompt cache of a native session stays warm while the person reads the
 * answer: a ping every 4.5 minutes, for as long as the session lives.
 * @covers RT-08
 *
 * The native loop's cache lives 5 minutes. On 18-24/10, 10 of 51 native turns
 * started 5 to 15 minutes after the previous one and each wrote its whole
 * prefix to the cache again (280k-416k tokens). Drives the REAL provider
 * against a stubbed API, on fake timers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider } from "./provider";
import type { StreamHandler } from "../types";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
let home: string;
let workspace: string;

const MIN = 60_000;
const EVERY = 270_000;

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const answer = sse([
  { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
]);
const pong = sse([{ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 5 } } }]);

interface Sent { model: string; max_tokens: number; system: unknown; tools: unknown; thinking?: unknown; messages: Array<{ role: string; content: unknown }> }
let turns: Sent[] = [];
let pings: Sent[] = [];

const quiet: StreamHandler = { onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {} };

/** Lets the timer's async callback (token, fetch, stream) run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await settle();
}

function provider(): NativeProvider {
  return new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-sonnet-5-5" });
}

const sweep = (p: NativeProvider) => (p as unknown as { sweepIdleSessions(): number }).sweepIdleSessions();

/** Strips the cache marks: where the breakpoint sits is not part of the prefix. */
const unmarked = (v: unknown) => JSON.parse(JSON.stringify(v), (k, x) => (k === "cache_control" ? undefined : x));

let turnDelayMs = 0;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "native-keepalive-home-"));
  workspace = mkdtempSync(join(tmpdir(), "native-keepalive-ws-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 365 * 24 * 3_600_000 } }),
  );
  process.env.HOME = home;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Sent;
    if (body.max_tokens === 1) {
      pings.push(body);
      return new Response(pong, { status: 200 });
    }
    turns.push(body);
    // A long turn: the clock moves while the model works.
    if (turnDelayMs) jest.advanceTimersByTime(turnDelayMs);
    return new Response(answer, { status: 200 });
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  turns = [];
  pings = [];
  turnDelayMs = 0;
  delete process.env.TOPICS_CACHE_KEEPALIVE;
  jest.useFakeTimers();
});

afterEach(() => jest.useRealTimers());

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.TOPICS_CACHE_KEEPALIVE;
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  for (const d of [home, workspace]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
});

describe("the native prompt-cache keep-alive", () => {
  test("pings at 4.5, 9 and 13.5 minutes with the turn's own prefix, then stops", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-pings", "first question", quiet);
    expect(turns.length).toBe(1);

    await advance(EVERY - 1_000);
    expect(pings.length).toBe(0);
    await advance(1_000);
    expect(pings.length).toBe(1);

    // Same model, tools, system and thinking as the turn; the messages are the
    // turn's plus its answer, then one short user line.
    const ping = pings[0]!;
    const turn = turns[0]!;
    expect(ping.model).toBe(turn.model);
    expect(unmarked(ping.tools)).toEqual(unmarked(turn.tools));
    expect(unmarked(ping.system)).toEqual(unmarked(turn.system));
    expect(ping.thinking).toEqual(turn.thinking);
    expect(unmarked(ping.messages.slice(0, turn.messages.length))).toEqual(unmarked(turn.messages));
    expect(ping.messages[turn.messages.length]).toMatchObject({ role: "assistant" });
    expect(ping.messages.length).toBe(turn.messages.length + 2);
    expect(ping.messages.at(-1)).toMatchObject({ role: "user" });

    await advance(EVERY);
    await advance(EVERY);
    expect(pings.length).toBe(3);
    // 18 minutes is past the session's 15: the session is about to be evicted
    // and rebuilt, a different prefix.
    await advance(EVERY * 3);
    expect(pings.length).toBe(3);
    p.stop();
  });

  test("a new turn ends the old pings and starts its own", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-new-turn", "first", quiet);
    await advance(2 * MIN);
    await p.sendChat("topic:keepalive-new-turn", "second", quiet);
    await advance(EVERY - 1_000);
    expect(pings.length).toBe(0);
    await advance(1_000);
    expect(pings.length).toBe(1);
    expect(JSON.stringify(pings[0]!.messages)).toContain("second");
    p.stop();
  });

  test("an evicted session is not pinged", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-evicted", "first", quiet);
    await advance(EVERY);
    expect(pings.length).toBe(1);
    await p.resetSession("topic:keepalive-evicted");
    await advance(EVERY);
    expect(pings.length).toBe(1);
    p.stop();
  });

  test("TOPICS_CACHE_KEEPALIVE=off: no pings", async () => {
    process.env.TOPICS_CACHE_KEEPALIVE = "off";
    const p = provider();
    await p.sendChat("topic:keepalive-off", "first", quiet);
    await advance(EVERY * 4);
    expect(pings.length).toBe(0);
    p.stop();
  });

  test("a turn longer than the session TTL is not evicted the minute it answers", async () => {
    const p = provider();
    turnDelayMs = 20 * MIN;
    await p.sendChat("topic:keepalive-long-turn", "a long task", quiet);
    turnDelayMs = 0;
    // Idle counts from the end of the turn, not from its start.
    expect(sweep(p)).toBe(0);
    await advance(EVERY);
    expect(pings.length).toBe(1);
    p.stop();
  });
});

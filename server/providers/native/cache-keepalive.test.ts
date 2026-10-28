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
import * as auth from "./auth";
import { NativeProvider } from "./provider";
import type { StreamHandler } from "../types";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
let home: string;
let workspace: string;

const MIN = 60_000;
const EVERY = 240_000;

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const answer = sse([
  { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
]);
const pong = sse([{ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 5 } } }]);
const refusal = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } },
]);
const badRequest = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "boom" } }, { status: 400 });

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

/**
 * Moves the wall clock ahead and leaves the timers' clock where it is: what a
 * sleep does to a pending setTimeout. Bun's fake timers set Date.now() to a
 * timer's due time when it fires, so `jest.setSystemTime` cannot make one late.
 */
function wallClockAhead(ms: number): () => void {
  const timersNow = Date.now.bind(Date);
  const spy = jest.spyOn(Date, "now").mockImplementation(() => timersNow() + ms);
  return () => spy.mockRestore();
}

function provider(): NativeProvider {
  return new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-sonnet-5-5" });
}

const sweep = (p: NativeProvider) => (p as unknown as { sweepIdleSessions(): number }).sweepIdleSessions();

/** Strips the cache marks: where the breakpoint sits is not part of the prefix. */
const unmarked = (v: unknown) => JSON.parse(JSON.stringify(v), (k, x) => (k === "cache_control" ? undefined : x));

let turnDelayMs = 0;
/** While set, a ping's answer waits for it: a tick stays in flight. */
let pingGate: Promise<void> | null = null;

const historyOf = (p: NativeProvider, key: string) =>
  (p as unknown as { sessions: Map<string, { history: unknown[] }> }).sessions.get(key)!.history;

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
      if (pingGate) await pingGate;
      return new Response(pong, { status: 200 });
    }
    turns.push(body);
    const asked = JSON.stringify(body.messages.at(-1));
    if (asked.includes("refuse-me")) return new Response(refusal, { status: 200 });
    if (asked.includes("fail-me")) return badRequest();
    // A long turn: the clock moves while the model works.
    if (turnDelayMs) jest.advanceTimersByTime(turnDelayMs);
    return new Response(answer, { status: 200 });
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  turns = [];
  pings = [];
  turnDelayMs = 0;
  pingGate = null;
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
  test("pings at 4, 8 and 12 minutes with the turn's own prefix, then stops", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-pings", "first question", quiet);
    expect(turns.length).toBe(1);
    const history = JSON.stringify(historyOf(p, "topic:keepalive-pings"));

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
    // The breakpoint sits on the answer, the end of the history: that is what
    // keeps the whole conversation warm, not only tools and system.
    const answerBlocks = ping.messages[turn.messages.length]!.content as Array<{ cache_control?: unknown }>;
    expect(answerBlocks.at(-1)?.cache_control).toBeDefined();
    // And the session's own history is not touched by the ping.
    expect(JSON.stringify(historyOf(p, "topic:keepalive-pings"))).toBe(history);

    await advance(EVERY);
    await advance(EVERY);
    expect(pings.length).toBe(3);
    // 16 minutes is past the session's 15: the session is about to be evicted
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

  test("a ping never lands on a running turn", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-running", "first", quiet);
    await advance(3 * MIN);
    // The second turn runs from minute 3 to minute 5: the first chain's tick
    // at 4 falls inside it.
    turnDelayMs = 2 * MIN;
    await p.sendChat("topic:keepalive-running", "second", quiet);
    turnDelayMs = 0;
    await settle();
    expect(pings.length).toBe(0);
    await advance(EVERY);
    expect(pings.length).toBe(1);
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
    p.stop();
  });

  test("the first ping counts from the start of the last request, not from the end of its answer", async () => {
    // The cache lives 5 minutes from the start of the request that last read
    // or wrote it. A one-minute answer leaves 3.5 minutes, not 4.5.
    const p = provider();
    turnDelayMs = MIN;
    await p.sendChat("topic:keepalive-anchor", "first", quiet);
    turnDelayMs = 0;
    await advance(EVERY - MIN - 1_000);
    expect(pings.length).toBe(0);
    await advance(1_000);
    expect(pings.length).toBe(1);
    p.stop();
  });

  test("a last request older than the 1h cache's life starts no pings: they would write, not read", async () => {
    const p = provider();
    // A turn that takes over 1 hour: the cache is cold by the time it ends.
    turnDelayMs = 61 * 60 * 1_000;
    await p.sendChat("topic:keepalive-expired", "a long answer", quiet);
    turnDelayMs = 0;
    await advance(EVERY * 3);
    expect(pings.length).toBe(0);
    p.stop();
  });

  test("a tick in flight across a new turn does not leave two chains running", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-two-chains", "first", quiet);
    let release = () => {};
    pingGate = new Promise<void>((resolve) => { release = resolve; });
    await advance(EVERY);
    expect(pings.length).toBe(1);
    // The ping hangs; a whole turn starts and ends meanwhile.
    await p.sendChat("topic:keepalive-two-chains", "second", quiet);
    pingGate = null;
    release();
    await settle();
    await advance(EVERY);
    expect(pings.length).toBe(2);
    await advance(EVERY);
    expect(pings.length).toBe(3);
    p.stop();
  });

  test("a turn that does not end with a text answer starts no pings", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-refusal", "refuse-me", quiet);
    await advance(EVERY * 3);
    expect(pings.length).toBe(0);
    p.stop();
  });

  test("a timer that fires late (the Mac asleep) does not ping an expired session", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-asleep", "first", quiet);
    // Asleep for 12 min: the timer due 4 min in fires at 16 min by the wall
    // clock, past the session's 15 min TTL. Cache (1h) is still alive, but
    // pinging a session about to be evicted is pointless.
    const restore = wallClockAhead(12 * MIN);
    try {
      await advance(EVERY);
      expect(pings.length).toBe(0);
    } finally {
      restore();
      p.stop();
    }
  });

  test("a timer that fires late past the session's 15 minutes does not ping", async () => {
    // Request at 0, answer at 1: pings at 4, 8, 12, and one due at 16,
    // 15 minutes after the answer. It fires 24 s late: the cache is still
    // alive (well within 1h) but the session is past its 15 min life.
    const p = provider();
    turnDelayMs = 1 * MIN;
    await p.sendChat("topic:keepalive-late-ttl", "first", quiet);
    turnDelayMs = 0;
    await advance(EVERY - 1 * MIN);
    await advance(EVERY);
    await advance(EVERY);
    expect(pings.length).toBe(3);
    const restore = wallClockAhead(24_000);
    try {
      await advance(EVERY);
      expect(pings.length).toBe(3);
    } finally {
      restore();
      p.stop();
    }
  });

  test("a session evicted while the tick reads its token is not pinged", async () => {
    const key = "topic:keepalive-token";
    const p = provider();
    await p.sendChat(key, "first", quiet);
    // The token comes from the Keychain, an asynchronous read (macOS): the
    // session is evicted while the tick waits on it.
    const item = { claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 365 * 24 * 3_600_000 } };
    const security = (_cmd: string, args: string[]): auth.KeychainRunResult => (args.includes("-w")
      ? { status: 0, stdout: `${JSON.stringify(item)}\n`, stderr: "" }
      : { status: 0, stdout: `    "acct"<blob>="someone"\n`, stderr: "" });
    let reads = 0;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const flag = process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    process.env.TOPICS_CREDENTIALS_KEYCHAIN = "1";
    auth.setKeychainRunnerForTests(security, async (cmd, args) => {
      reads++;
      await p.resetSession(key);
      return security(cmd, args);
    });
    try {
      await advance(EVERY);
      expect(reads).toBeGreaterThan(0);
      expect(pings.length).toBe(0);
    } finally {
      auth.setKeychainRunnerForTests(null);
      Object.defineProperty(process, "platform", platform);
      if (flag === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN; else process.env.TOPICS_CREDENTIALS_KEYCHAIN = flag;
      p.stop();
    }
  });

  test("a failed turn ends the chain of the turn before it", async () => {
    const p = provider();
    await p.sendChat("topic:keepalive-failed", "first", quiet);
    await advance(2 * MIN);
    await p.sendChat("topic:keepalive-failed", "fail-me", quiet);
    await advance(EVERY * 3);
    expect(pings.length).toBe(0);
    p.stop();
  });
});

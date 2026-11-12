/**
 * A REQUEST THAT NEVER GETS ITS HEADERS DOES NOT HOLD THE TURN FOREVER.
 *
 * ── The defect (2026-11-11 23:07, topic:fe68802e) ───────────────────────────
 * A Discord turn ran for 40+ minutes without a single round. Its turn host
 * held a socket in SYN_SENT towards Switchboard (127.0.0.1:3336), which kept
 * answering everyone else in 0.6 s. `streamOnce` called `fetch` with the
 * turn's Stop signal and nothing else, so a connection that never answered was
 * waited on until someone pressed Stop; the route kept extending its own
 * deadlines because the host process was alive.
 *
 * Reproduced with a local TCP server that accepts the connection and never
 * writes a byte. That socket is ESTABLISHED, not SYN_SENT, and it does not
 * need to be: the timer aborts the fetch whatever the socket's state, and the
 * real `fetch` runs against it (no fake), through `ANTHROPIC_BASE_URL`.
 *
 * The account engine's settings are served by a second local server
 * (`TOPICS_SWITCHBOARD_URL`): a hold it declares is a wait, not a dead socket.
 * @covers CHAT-REL-09
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";
import { ApiHeadersTimeoutError, ApiHttpError, MAX_HEADERS_TIMEOUTS, retryRound, type RetryPolicy } from "./retry";

const saved = {
  HOME: process.env.HOME,
  TOPICS_CREDENTIALS_KEYCHAIN: process.env.TOPICS_CREDENTIALS_KEYCHAIN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  TOPICS_SWITCHBOARD_URL: process.env.TOPICS_SWITCHBOARD_URL,
};
let homeDir: string;
let ws: string;
let silent: { port: number; stop: (force?: boolean) => void };
let connections = 0;
/** The account engine's dashboard: answers its settings with this hold. */
let engine: ReturnType<typeof Bun.serve>;
let holdMin = 0;
/** An API that answers, after `answerAfterMs`, with a stream whose deltas take `bodyMs`. */
let slowApi: ReturnType<typeof Bun.serve>;
let answerAfterMs = 0;
let bodyMs = 0;
let slowRequests = 0;

const okEvents = [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

const HEADERS_MS = 150;

function restore(key: keyof typeof saved) {
  if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
}

interface Ledger { errors: string[]; retries: string[]; aborted: number; done: number; text: string }

const ledger = (): Ledger => ({ errors: [], retries: [], aborted: 0, done: 0, text: "" });

function handler(reg: Ledger): StreamHandler {
  return {
    onTextDelta: (d: string) => { reg.text += d; },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => { reg.done++; },
    onError: (e: string) => { reg.errors.push(e); },
    onAborted: () => { reg.aborted++; },
    onRetry: (info) => { reg.retries.push(info.reason); },
  };
}

function turn(reg: Ledger, policy: RetryPolicy, signal?: AbortSignal) {
  const history: AgentMessage[] = [{ role: "user", content: "ciao" }];
  return runAgentTurn({
    model: "claude-haiku-4-5-20251001",
    history,
    toolContext: { workspace: ws },
    autonomy: "auto-apply",
    retryPolicy: policy,
    headersTimeoutMs: HEADERS_MS,
    signal,
  }, handler(reg));
}

describe("a round whose request never gets response headers", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-headers-home-"));
    ws = mkdtempSync(join(tmpdir(), "native-headers-ws-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = homeDir;
    delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    // Accepts every connection, reads the request, never answers.
    silent = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open() { connections++; }, data() {} },
    });
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${silent.port}`;
    engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ usageCapHoldMin: holdMin }) });
    process.env.TOPICS_SWITCHBOARD_URL = `http://127.0.0.1:${engine.port}`;
    slowApi = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 30,
      async fetch() {
        slowRequests++;
        await Bun.sleep(answerAfterMs);
        const gap = bodyMs / okEvents.length;
        const stream = new ReadableStream({
          async start(c) {
            for (const e of okEvents) {
              c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
              await Bun.sleep(gap);
            }
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
  });

  afterAll(() => {
    silent.stop(true);
    engine.stop(true);
    slowApi.stop(true);
    restore("TOPICS_SWITCHBOARD_URL");
    restore("HOME");
    restore("TOPICS_CREDENTIALS_KEYCHAIN");
    restore("ANTHROPIC_BASE_URL");
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  beforeEach(() => {
    holdMin = 0;
    answerAfterMs = 0;
    bodyMs = 0;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${silent.port}`;
  });

  test("is retried on a new connection and then closes with an error instead of hanging", async () => {
    const reg = ledger();
    const before = connections;
    const policy: RetryPolicy = { maxAttempts: 28, baseMs: 1, capMs: 4, jitter: () => 1 };
    const started = Date.now();
    let message = "";
    await turn(reg, policy).catch((e: Error) => { message = e.message; });
    const elapsed = Date.now() - started;

    // Each attempt waited about HEADERS_MS, and the round stopped after the
    // allowed number of timeouts, not after the policy's 28 attempts.
    expect(elapsed).toBeLessThan(5_000);
    expect(message).toContain("no response headers");
    expect(message).toContain(`retried ${MAX_HEADERS_TIMEOUTS - 1} times`);
    expect(reg.retries).toEqual(Array(MAX_HEADERS_TIMEOUTS - 1).fill("network"));
    expect(connections - before).toBe(MAX_HEADERS_TIMEOUTS);
    // Not a Stop: nothing reported the turn as cancelled.
    expect(reg.aborted).toBe(0);
    expect(reg.done).toBe(0);
  }, 15_000);

  test("a Stop while waiting for headers closes the fetch at once and is not a timeout", async () => {
    const reg = ledger();
    const before = connections;
    const stop = new AbortController();
    const policy: RetryPolicy = { maxAttempts: 4, baseMs: 1, capMs: 4, jitter: () => 1 };
    let stoppedAt = 0;
    let err: unknown;
    setTimeout(() => { stoppedAt = Date.now(); stop.abort("user"); }, HEADERS_MS / 3);
    await turn(reg, policy, stop.signal).catch((e) => { err = e; });
    // The Stop closes the fetch itself: it does not wait for the headers timer.
    expect(Date.now() - stoppedAt).toBeLessThan(HEADERS_MS / 2);
    expect(err).not.toBeInstanceOf(ApiHeadersTimeoutError);
    expect(String((err as Error | undefined)?.message ?? "")).not.toContain("no response headers");
    expect(reg.retries).toEqual([]);
    expect(connections - before).toBe(1);
  }, 15_000);

  test("a Stop that lands after the timer fired, before the fetch let go, is still a Stop", async () => {
    // A fake fetch that rejects 100 ms after its signal aborts: the timer
    // fires first, the Stop lands while the fetch is still letting go.
    const realFetch = globalThis.fetch;
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/v1/messages")) return realFetch(url, init);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => setTimeout(() => reject(new Error("aborted")), 100));
      });
    }) as typeof fetch;
    try {
      const reg = ledger();
      const stop = new AbortController();
      setTimeout(() => stop.abort("user"), HEADERS_MS + 60);
      let err: unknown;
      await turn(reg, { maxAttempts: 4, baseMs: 1, capMs: 4, jitter: () => 1 }, stop.signal).catch((e) => { err = e; });
      expect(err).not.toBeInstanceOf(ApiHeadersTimeoutError);
      expect(reg.retries).toEqual([]);
      expect(warnings.some((w) => w.includes("no response headers"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      console.warn = realWarn;
    }
  }, 15_000);

  test("headers that arrive in time free the body from the timer: a stream longer than it is not cut", async () => {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${slowApi.port}`;
    bodyMs = HEADERS_MS * 4;
    const reg = ledger();
    await turn(reg, { maxAttempts: 2, baseMs: 1, capMs: 4, jitter: () => 1 });
    expect(reg.retries).toEqual([]);
    expect(reg.done).toBe(1);
    expect(reg.text).toBe("ok");
  }, 15_000);

  test("an engine that declares a hold is waited on, on the same socket, past the headers timer", async () => {
    // Switchboard parks a request while every account is capped: no header
    // until an account frees up. Cutting it would turn a wait into an error.
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${slowApi.port}`;
    holdMin = 1;
    answerAfterMs = HEADERS_MS * 4;
    const before = slowRequests;
    const reg = ledger();
    await turn(reg, { maxAttempts: 4, baseMs: 1, capMs: 4, jitter: () => 1 });
    expect(reg.retries).toEqual([]);
    expect(reg.done).toBe(1);
    expect(slowRequests - before).toBe(1);
  }, 15_000);
});

describe("the count of header timeouts in a round", () => {
  test("is not reset by another failure in between: a stray 503 does not buy three more timeouts", async () => {
    const seq = [
      () => new ApiHeadersTimeoutError("no response headers"),
      () => new ApiHeadersTimeoutError("no response headers"),
      () => new ApiHttpError("overloaded", 503),
      () => new ApiHeadersTimeoutError("no response headers"),
      () => new ApiHeadersTimeoutError("no response headers"),
    ];
    let calls = 0;
    let message = "";
    await retryRound(async () => { throw seq[calls++]!(); }, {
      auth: { token: "t" },
      policy: { maxAttempts: 28, baseMs: 1, capMs: 2, jitter: () => 1 },
      renewToken: async () => null,
    }).catch((e: Error) => { message = e.message; });
    expect(calls).toBe(4);
    expect(message).toContain("no response headers");
  });
});

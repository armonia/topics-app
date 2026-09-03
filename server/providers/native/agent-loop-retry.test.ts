/**
 * A TRANSIENT FAILURE OF THE API IS NOT THE END OF THE TURN.
 *
 * ── The defect (2026-09-03, topic:9cb7c969) ─────────────────────────────────
 * Two turns in the same chat died within a second of Enter, and stayed dead:
 *   · 13:14:01.746 user message → 13:14:01.789 `⚠️ stream error:
 *     {"type":"overloaded_error"}`. The API answered 200 with the overload as
 *     the first SSE event.
 *   · 10:26:47.654 user message → 10:26:47.898 `⚠️ API 401: OAuth access token
 *     has been revoked`. The CLI had rotated the refresh token; the file on disk
 *     already had the new pair; the server kept using the old one.
 * `streamOnce` threw, nothing caught it, the chat got a ⚠️ and a Retry button
 * the person had to press by hand. Claude Code recovers from both without
 * anyone noticing.
 *
 * Driven against a fake `fetch` like the tests next door: each call gets the
 * next scripted answer, and the interesting cases (a 529, an overload inside a
 * 200, a token that changes under us) are scripts instead of outages to wait
 * for. The retry policy is measured in milliseconds so the suite stays fast.
 * @covers CHAT-REL-06
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";
import type { RetryPolicy } from "./retry";

const HOME_VERA = process.env.HOME;
let homeDir: string;
let ws: string;
let credPath: string;
const realFetch = globalThis.fetch;

const FAST: RetryPolicy = { maxAttempts: 4, baseMs: 1, capMs: 4, jitter: () => 1 };

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const healthyRound = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

/** The measured shape: a 200 whose first and only event is the overload. */
const overloadedInStream = sse([
  { type: "error", error: { details: null, type: "overloaded_error", message: "Overloaded" } },
]);

/** Same error, but AFTER the model had already said something. */
const overloadedAfterText = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sto per" } },
  { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
]);

type Scripted = Response | (() => Response) | Error;

interface Ledger {
  done: number;
  errors: string[];
  retries: Array<{ attempt: number; maxAttempts: number; delayMs: number; reason: string }>;
  aborted: number;
  text: string;
  authHeaders: string[];
}

function handler(reg: Ledger): StreamHandler {
  return {
    onTextDelta: (d) => { reg.text += d; },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => { reg.done++; },
    onError: (e: string) => { reg.errors.push(e); },
    onAborted: () => { reg.aborted++; },
    onRetry: (info) => { reg.retries.push(info); },
  };
}

function scriptFetch(answers: Scripted[], reg: Ledger) {
  let n = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    reg.authHeaders.push(h.authorization ?? "");
    const a = answers[Math.min(n++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a() : a;
  }) as unknown as typeof fetch;
  return () => n;
}

function ok(body: string) { return () => new Response(body, { status: 200 }); }
function status(code: number, headers?: Record<string, string>) {
  return () => new Response(JSON.stringify({ type: "error", error: { type: "x", message: `status ${code}` } }), { status: code, headers });
}

async function turn(reg: Ledger, opts: { signal?: AbortSignal; policy?: RetryPolicy } = {}) {
  const history: AgentMessage[] = [{ role: "user", content: "ciao" }];
  return runAgentTurn(
    {
      model: "claude-haiku-4-5-20251001",
      history,
      toolContext: { workspace: ws },
      autonomy: "auto-apply",
      retryPolicy: opts.policy ?? FAST,
      signal: opts.signal,
    },
    handler(reg),
  );
}

function fresh(): Ledger {
  return { done: 0, errors: [], retries: [], aborted: 0, text: "", authHeaders: [] };
}

function writeCreds(accessToken: string) {
  writeFileSync(
    credPath,
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
  );
}

describe("the native loop tries again when the API's failure is transient", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "native-retry-home-"));
    ws = mkdtempSync(join(tmpdir(), "native-retry-ws-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    credPath = join(homeDir, ".claude", ".credentials.json");
    process.env.HOME = homeDir;
  });

  beforeEach(() => { writeCreds("token-A"); });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("overloaded_error inside a 200, then a healthy round: the turn finishes, one retry announced (the 13:14 case)", async () => {
    const reg = fresh();
    const calls = scriptFetch([ok(overloadedInStream), ok(healthyRound)], reg);
    const out = await turn(reg);
    expect(calls()).toBe(2);
    expect(out.turnEnd.end).toBe("end_turn");
    expect(reg.done).toBe(1);
    expect(reg.errors).toEqual([]);
    expect(reg.text).toBe("fatto");
    expect(reg.retries.length).toBe(1);
    expect(reg.retries[0]!.reason).toBe("stream overloaded_error");
    expect(reg.retries[0]!.attempt).toBe(1);
  });

  test("HTTP 529 twice, then healthy: two retries with growing waits", async () => {
    const reg = fresh();
    const calls = scriptFetch([status(529), status(529), ok(healthyRound)], reg);
    const out = await turn(reg);
    expect(calls()).toBe(3);
    expect(out.turnEnd.end).toBe("end_turn");
    expect(reg.errors).toEqual([]);
    expect(reg.retries.map((r) => r.reason)).toEqual(["API 529", "API 529"]);
    expect(reg.retries[1]!.delayMs).toBeGreaterThan(reg.retries[0]!.delayMs);
  });

  test("a dropped connection before any byte is retried too", async () => {
    const reg = fresh();
    const calls = scriptFetch([new TypeError("fetch failed"), ok(healthyRound)], reg);
    const out = await turn(reg);
    expect(calls()).toBe(2);
    expect(out.turnEnd.end).toBe("end_turn");
    expect(reg.retries[0]!.reason).toBe("network");
  });

  test("retry-after is honoured as the floor of the wait", async () => {
    const reg = fresh();
    scriptFetch([status(429, { "retry-after": "0.05" }), ok(healthyRound)], reg);
    await turn(reg);
    expect(reg.retries[0]!.delayMs).toBeGreaterThanOrEqual(50);
  });

  // What follows are the failures the loop does NOT swallow. They leave by
  // exception, as before this change, and `provider.ts` turns them into
  // `onError`: the tests assert the sentence that reaches it.
  test("attempts run out: the error says how many were spent", async () => {
    const reg = fresh();
    const calls = scriptFetch([status(503)], reg);
    let msg = "";
    await turn(reg).catch((e: Error) => { msg = e.message; });
    expect(msg).toContain("API 503");
    expect(msg).toContain(`retried ${FAST.maxAttempts - 1} times`);
    expect(calls()).toBe(FAST.maxAttempts);
    expect(reg.done).toBe(0);
    expect(reg.retries.length).toBe(FAST.maxAttempts - 1);
  });

  test("a 400 is the request's fault: no retry, the error passes as it came", async () => {
    const reg = fresh();
    const calls = scriptFetch([status(400), ok(healthyRound)], reg);
    let msg = "";
    await turn(reg).catch((e: Error) => { msg = e.message; });
    expect(calls()).toBe(1);
    expect(reg.retries).toEqual([]);
    expect(msg).toContain("API 400");
    expect(msg).not.toContain("retried");
  });

  test("overloaded AFTER text was shown: not replayed, reported (a retry would print the text twice)", async () => {
    const reg = fresh();
    const calls = scriptFetch([ok(overloadedAfterText), ok(healthyRound)], reg);
    await expect(turn(reg)).rejects.toThrow("overloaded_error");
    expect(calls()).toBe(1);
    expect(reg.text).toBe("sto per");
    expect(reg.retries).toEqual([]);
  });

  test("401 on a token the CLI rotated under us: the file is re-read and the call repeated with the new token (the 10:26 case)", async () => {
    const reg = fresh();
    // The first call fails with 401 and, "meanwhile", another process writes
    // the new pair to disk: the file carries token-B by the time we look.
    const calls = scriptFetch([
      () => { writeCreds("token-B"); return new Response('{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}', { status: 401 }); },
      ok(healthyRound),
    ], reg);
    const out = await turn(reg);
    expect(calls()).toBe(2);
    expect(out.turnEnd.end).toBe("end_turn");
    expect(reg.errors).toEqual([]);
    expect(reg.authHeaders).toEqual(["Bearer token-A", "Bearer token-B"]);
    expect(reg.retries.length).toBe(1);
    expect(reg.retries[0]!.reason).toBe("API 401");
    expect(reg.retries[0]!.delayMs).toBe(0);
  });

  test("401 with the same token still on disk and a refresh that fails: one more attempt at most, then a clear sentence", async () => {
    const reg = fresh();
    // The refresh goes through the same fake fetch (the token endpoint) and is
    // refused: the refresh token is gone for real.
    const calls = scriptFetch([
      status(401),
      () => new Response('{"error":"invalid_grant"}', { status: 400 }),
      status(401),
    ], reg);
    let msg = "";
    await turn(reg).catch((e: Error) => { msg = e.message; });
    expect(msg).toContain("API 401");
    expect(msg).toContain("/login");
    // One API call, one refresh call: no loop.
    expect(calls()).toBe(2);
  });

  test("Stop during the backoff: the turn ends as cancelled, not as an error, and no further call is made", async () => {
    const reg = fresh();
    const ac = new AbortController();
    const slow: RetryPolicy = { maxAttempts: 5, baseMs: 5_000, capMs: 5_000, jitter: () => 1 };
    const calls = scriptFetch([status(529)], reg);
    const p = turn(reg, { signal: ac.signal, policy: slow });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("user");
    await p.catch(() => undefined);
    expect(calls()).toBe(1);
    expect(reg.retries.length).toBe(1);
    expect(reg.errors).toEqual([]);
  });
});

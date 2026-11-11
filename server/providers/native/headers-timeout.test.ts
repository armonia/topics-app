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
 * writes a byte: the closest the loopback gets to a socket that never opens.
 * The real `fetch` runs against it (no fake), through `ANTHROPIC_BASE_URL`.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";
import { MAX_HEADERS_TIMEOUTS, type RetryPolicy } from "./retry";

const saved = {
  HOME: process.env.HOME,
  TOPICS_CREDENTIALS_KEYCHAIN: process.env.TOPICS_CREDENTIALS_KEYCHAIN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
};
let homeDir: string;
let ws: string;
let silent: { port: number; stop: (force?: boolean) => void };
let connections = 0;

const HEADERS_MS = 150;

function restore(key: keyof typeof saved) {
  if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
}

interface Ledger { errors: string[]; retries: string[]; aborted: number; done: number }

function handler(reg: Ledger): StreamHandler {
  return {
    onTextDelta: () => {},
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
  });

  afterAll(() => {
    silent.stop(true);
    restore("HOME");
    restore("TOPICS_CREDENTIALS_KEYCHAIN");
    restore("ANTHROPIC_BASE_URL");
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("is retried on a new connection and then closes with an error instead of hanging", async () => {
    const reg: Ledger = { errors: [], retries: [], aborted: 0, done: 0 };
    const before = connections;
    const policy: RetryPolicy = { maxAttempts: 28, baseMs: 1, capMs: 4, jitter: () => 1 };
    const started = Date.now();
    let message = "";
    await turn(reg, policy).catch((e: Error) => { message = e.message; });
    const elapsed = Date.now() - started;

    // Each attempt waited about HEADERS_MS, and the round stopped after the
    // allowed run of timeouts, not after the policy's 28 attempts.
    expect(elapsed).toBeLessThan(5_000);
    expect(message).toContain("no response headers");
    expect(message).toContain(`retried ${MAX_HEADERS_TIMEOUTS - 1} times`);
    expect(reg.retries).toEqual(Array(MAX_HEADERS_TIMEOUTS - 1).fill("network"));
    expect(connections - before).toBe(MAX_HEADERS_TIMEOUTS);
    // Not a Stop: nothing reported the turn as cancelled.
    expect(reg.aborted).toBe(0);
    expect(reg.done).toBe(0);
  }, 15_000);

  test("a Stop while waiting for headers is still a cancellation, not a timeout", async () => {
    const reg: Ledger = { errors: [], retries: [], aborted: 0, done: 0 };
    const stop = new AbortController();
    const policy: RetryPolicy = { maxAttempts: 4, baseMs: 1, capMs: 4, jitter: () => 1 };
    setTimeout(() => stop.abort("user"), HEADERS_MS / 3);
    await turn(reg, policy, stop.signal).catch(() => undefined);
    expect(reg.retries).toEqual([]);
  }, 15_000);
});

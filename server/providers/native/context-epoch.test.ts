/**
 * The native runtime's context epoch: the number the chat route folds into
 * the inline dedup scope, so a session rebuilt from the database gets its
 * context block again.
 * @covers CTX-DEDUP-02
 *
 * Drives the REAL provider against a stubbed API, and moves the clock instead
 * of waiting the 15 minutes of the eviction.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider } from "./provider";
import type { StreamHandler } from "../types";

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
const realNow = Date.now;
let offsetMs = 0;
let home: string;
let workspace: string;

const answer = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const quiet: StreamHandler = { onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {} };
const MIN = 60_000;

function provider(): NativeProvider {
  return new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
}

/** The sweep the provider's timer runs every minute. */
const sweep = (p: NativeProvider) => (p as unknown as { sweepIdleSessions(): number }).sweepIdleSessions();

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "native-epoch-home-"));
  workspace = mkdtempSync(join(tmpdir(), "native-epoch-ws-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: realNow() + 3_600_000 } }),
  );
  process.env.HOME = home;
  globalThis.fetch = (async () => new Response(answer, { status: 200 })) as unknown as typeof fetch;
  Date.now = () => realNow() + offsetMs;
});

afterAll(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  for (const d of [home, workspace]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
});

describe("the native context epoch", () => {
  test("stays put while the session lives, and moves when an evicted session is rebuilt", async () => {
    offsetMs = 0;
    const p = provider();
    const key = "topic:epoch-rebuild";

    // Before the first turn it names the session the turn will build.
    const first = p.contextEpoch(key);
    await p.sendChat(key, "one", quiet);
    expect(p.contextEpoch(key)).toBe(first);
    await p.sendChat(key, "two", quiet);
    expect(p.contextEpoch(key)).toBe(first);

    // Idle past the 15-minute TTL: the sweep evicts it, the next turn rebuilds it.
    offsetMs = 16 * MIN;
    expect(sweep(p)).toBe(1);
    const next = p.contextEpoch(key);
    expect(next).toBe(first + 1);
    await p.sendChat(key, "three", quiet);
    expect(p.contextEpoch(key)).toBe(next);
  });

  test("reading it keeps a live session from being evicted before the turn arrives", async () => {
    offsetMs = 0;
    const p = provider();
    const key = "topic:epoch-touch";
    await p.sendChat(key, "one", quiet);
    const epoch = p.contextEpoch(key);

    // The route composes the turn at minute 10, the sweep runs at minute 16:
    // the session has been idle 6 minutes since the route read the epoch.
    offsetMs = 10 * MIN;
    expect(p.contextEpoch(key)).toBe(epoch);
    offsetMs = 16 * MIN;
    expect(sweep(p)).toBe(0);
    expect(p.contextEpoch(key)).toBe(epoch);
  });

  test("a new provider instance does not hand out an epoch the dedup already saw", async () => {
    offsetMs = 0;
    const key = "topic:epoch-new-instance";
    const before = provider();
    await before.sendChat(key, "one", quiet);
    const used = before.contextEpoch(key);
    before.stop();
    expect(provider().contextEpoch(key)).toBe(used + 1);
  });
});

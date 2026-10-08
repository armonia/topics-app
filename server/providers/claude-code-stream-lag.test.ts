/**
 * A live broker turn must catch up BY ITSELF with what its child already wrote,
 * within seconds of losing the stream, without a page reload (T18).
 *
 * Each case drives a REAL ai-bridge daemon and a fake CLI that keeps writing
 * numbered text for the whole turn, then cuts the delivery halfway in one of
 * the ways production cuts it:
 *
 *  - the daemon forgets our attachment while the socket stays up (a reconnect
 *    whose re-attach timed out, a spawn acked without an attach);
 *  - the broker socket drops and the first reconnect attempt fails, so the
 *    `onReconnect` callbacks never ran and nobody re-attached.
 *
 * Before the fix nothing in the provider noticed: the turn stayed behind until
 * the route's grace expiry (two minutes, and only for a turn sent over SSE) or
 * the stale-stream sweep (three minutes). "Aligned" is measured on the server
 * side: the provider has folded every byte the daemon holds for the session,
 * and the text the handler received is the whole sequence, once.
 * @covers CCLI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-stream-lag-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

/** A CLI that answers each stdin line with `count` numbered text events, one
 *  every `stepSec`, then a `result`. The numbers make a gap or a duplicate
 *  visible in the text the handler accumulates. */
function writeCountingCli(name: string, count: number, stepSec: string): string {
  const p = join(tempDir, name);
  writeFileSync(p, `#!/bin/sh
while read line; do
  i=1
  while [ $i -le ${count} ]; do
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' $i
    sleep ${stepSec}
    i=$((i+1))
  done
  printf '{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}\\n'
done
`);
  chmodSync(p, 0o755);
  return p;
}

async function seedTopic(sessionKey: string, id: string) {
  const { initDatabase, getDatabase } = await import("../db");
  initDatabase(REPO_ROOT);
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT OR IGNORE INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, id, sessionKey, now, now);
}

function counting() {
  let text = "";
  let deltas = 0;
  let ended: string | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const handler: any = {
    onTextDelta: (delta: string) => { text += delta; deltas++; },
    onToolStart: () => {}, onToolResult: () => {}, onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
    onAborted: (info: any) => { ended = `aborted:${info?.turnEnd?.cause ?? info?.turnEnd?.end ?? "?"}`; resolveDone(); },
    onDone: () => { ended = "done"; resolveDone(); },
    onError: (e: string) => { ended = `error:${e}`; resolveDone(); },
  };
  return { handler, done, get text() { return text; }, get deltas() { return deltas; }, get ended() { return ended; } };
}

/** The numbers the handler received, in order. */
function numbersOf(text: string): number[] {
  return text.split(",").filter(Boolean).map(Number);
}

/** Every number once, in order, from 1: no gap, no duplicate. */
function expectContiguous(text: string): void {
  const got = numbersOf(text);
  const want = got.map((_, i) => i + 1);
  expect(got).toEqual(want);
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-bridge-stream-lag-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", SOCK);
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
});

afterAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  try { (await import("../db")).closeDatabase(); } catch { /* not opened */ }
  try {
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch { /* gone */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("claude-code provider · a re-attach never folds a byte twice", () => {
  test("resyncs that overlap (reconnect chain, watchdog, sweep) while the child writes: every number once", async () => {
    const sessionKey = "topic:lag-overlap";
    await seedTopic(sessionKey, "t-lag-overlap");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeCountingCli("cli-overlap.sh", 1500, "0"));
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    const sink = counting();
    const turn = provider.sendChat(sessionKey, "go", sink.handler).catch(() => {});
    try {
      const until = Date.now() + 10_000;
      while (sink.deltas < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
      // Still attached and the child still writing: frames are in flight while
      // several callers ask for a re-attach from the same consumed offset.
      while (sink.ended === null) {
        await Promise.all([provider.resyncStream(sessionKey), provider.resyncStream(sessionKey)]);
        await new Promise((r) => setTimeout(r, 5));
      }
      await sink.done;
      await turn;
      expect(sink.ended).toBe("done");
      expectContiguous(sink.text);
      expect(numbersOf(sink.text).length).toBe(1500);
    } finally {
      provider.stop();
      try { getAiBridgeClient().kill(sessionKey); } catch { /* gone */ }
    }
  }, 40_000);
});

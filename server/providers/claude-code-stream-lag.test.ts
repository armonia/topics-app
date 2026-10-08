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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-stream-lag-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

/** The production target of the track: aligned again within 15 s of the cut. */
const ALIGN_BUDGET_MS = 15_000;

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

/**
 * Has the provider folded everything the daemon holds for this session?
 *
 * Read off the store FILE, not through the bridge: a `list` from here would
 * reconnect a dropped socket by itself and fire the re-attach this test is
 * checking nobody else fires. The store is append-only, so its size is the
 * daemon's `endOffset`.
 */
async function lagBytes(provider: any, sessionKey: string): Promise<number> {
  const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
  const store = join(getAiBridgeClient().storeDir, `${sessionKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.ndjson`);
  const pp = provider.processes.get(sessionKey);
  if (!existsSync(store) || !pp) return -1;
  return statSync(store).size - pp.consumedOffset;
}

/** Waits until the daemon holds bytes we have not folded: the cut is real. */
async function waitBehind(provider: any, sessionKey: string, minBytes: number): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if ((await lagBytes(provider, sessionKey)) >= minBytes) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the stream never fell behind: the cut did not take");
}

/** ms from `cutAt` until the provider is aligned again, or null within `budgetMs` of the cut. */
async function msToAlign(provider: any, sessionKey: string, budgetMs: number, cutAt: number): Promise<number | null> {
  while (Date.now() - cutAt < budgetMs) {
    if ((await lagBytes(provider, sessionKey)) === 0) return Date.now() - cutAt;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
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

describe("claude-code provider · a live turn catches up by itself (B1)", () => {
  test("the daemon forgets our attachment mid-turn: aligned again within 15 s, every number once", async () => {
    const sessionKey = "topic:lag-detached";
    await seedTopic(sessionKey, "t-lag-det");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeCountingCli("cli-detached.sh", 400, "0.05"));
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    const sink = counting();
    void provider.sendChat(sessionKey, "go", sink.handler).catch(() => {});
    try {
      const until = Date.now() + 10_000;
      while (sink.deltas < 10 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      expect(sink.deltas).toBeGreaterThanOrEqual(10);

      // The attachment goes, the socket stays: nothing reconnects, nothing fires.
      const cutAt = Date.now();
      getAiBridgeClient().detach(sessionKey);
      await waitBehind(provider, sessionKey, 500);

      const ms = await msToAlign(provider, sessionKey, ALIGN_BUDGET_MS, cutAt);
      console.log(`[T18 B1 detached] aligned after ${ms === null ? `>${ALIGN_BUDGET_MS}` : ms} ms`);
      expect(ms).not.toBeNull();
      expectContiguous(sink.text);
    } finally {
      provider.stop();
      try { getAiBridgeClient().kill(sessionKey); } catch { /* gone */ }
    }
  }, 40_000);

  test("the broker socket drops and the first reconnect fails: aligned again within 15 s, every number once", async () => {
    const sessionKey = "topic:lag-socket";
    await seedTopic(sessionKey, "t-lag-sock");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeCountingCli("cli-socket.sh", 400, "0.05"));
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    const sink = counting();
    void provider.sendChat(sessionKey, "go", sink.handler).catch(() => {});
    const client = getAiBridgeClient() as any;
    try {
      const until = Date.now() + 10_000;
      while (sink.deltas < 10 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      expect(sink.deltas).toBeGreaterThanOrEqual(10);

      // The reconnect the `close` handler schedules fails once, the way it
      // fails on a machine in swap ("failed to connect after spawning daemon",
      // the spawn cap): its `.catch` swallows it and the callbacks that
      // re-attach the live sessions never run. The next caller connects fine.
      const real = client.ensureConnected;
      let failedOnce = false;
      client.ensureConnected = function (this: unknown) {
        if (!failedOnce && !client.ready) { failedOnce = true; return Promise.reject(new Error("ai-bridge: failed to connect after spawning daemon")); }
        return real.call(this);
      };
      const cutAt = Date.now();
      try {
        client.socket.destroy();
        const wait = Date.now() + 5_000;
        while (!failedOnce && Date.now() < wait) await new Promise((r) => setTimeout(r, 20));
        expect(failedOnce).toBe(true);
      } finally {
        delete client.ensureConnected;
      }
      await waitBehind(provider, sessionKey, 500);

      const ms = await msToAlign(provider, sessionKey, ALIGN_BUDGET_MS, cutAt);
      console.log(`[T18 B1 socket] aligned after ${ms === null ? `>${ALIGN_BUDGET_MS}` : ms} ms`);
      expect(ms).not.toBeNull();
      expectContiguous(sink.text);
    } finally {
      provider.stop();
      try { getAiBridgeClient().kill(sessionKey); } catch { /* gone */ }
    }
  }, 40_000);

  test("control: the broker socket drops and reconnects at once — the re-attach on reconnect already aligns it", async () => {
    const sessionKey = "topic:lag-socket-ok";
    await seedTopic(sessionKey, "t-lag-sock-ok");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeCountingCli("cli-socket-ok.sh", 400, "0.05"));
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    const sink = counting();
    void provider.sendChat(sessionKey, "go", sink.handler).catch(() => {});
    try {
      const until = Date.now() + 10_000;
      while (sink.deltas < 10 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      const cutAt = Date.now();
      (getAiBridgeClient() as any).socket.destroy();
      await waitBehind(provider, sessionKey, 1);
      const ms = await msToAlign(provider, sessionKey, ALIGN_BUDGET_MS, cutAt);
      console.log(`[T18 B1 socket-ok] aligned after ${ms === null ? `>${ALIGN_BUDGET_MS}` : ms} ms`);
      expect(ms).not.toBeNull();
      expectContiguous(sink.text);
    } finally {
      provider.stop();
      try { getAiBridgeClient().kill(sessionKey); } catch { /* gone */ }
    }
  }, 40_000);
});

describe("claude-code provider · a rescue that cannot act says why (B2)", () => {
  test("the daemon holds a live child no process of ours drives: the rescue re-attaches nothing and says so", async () => {
    const sessionKey = "topic:lag-orphan";
    await seedTopic(sessionKey, "t-lag-orphan");
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const { rescueByOwner } = await import("../lib/stale-stream-sweep");
    const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    // A child alive in the daemon, absent from `processes`: a server that lost
    // the session while the daemon kept it, the boot adoption not there yet.
    const client = getAiBridgeClient();
    client.registerHandlers(sessionKey, { onData: () => {} });
    await client.spawn(sessionKey, { cliPath: "cat", args: [], cwd: tempDir, env: {} });
    client.unregister(sessionKey);
    const said: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
    try {
      const ok = await rescueByOwner(sessionKey, provider, (m) => said.push(m));
      expect(ok).toBe(false);
    } finally {
      console.warn = realWarn;
      provider.stop();
      try { client.kill(sessionKey); } catch { /* gone */ }
    }
    // The provider says what it found, the daemon side included.
    expect(said.some((l) => l.includes(`Stream resync for ${sessionKey}: nothing to re-attach`) && l.includes("the daemon holds a live child"))).toBe(true);
    // And the rescue says it did nothing.
    expect(said.some((l) => l.includes(`rescue of ${sessionKey}`) && l.includes("did not re-attach"))).toBe(true);
  }, 30_000);
});

describe("claude-code provider · a silent, healthy child is left alone (B4)", () => {
  test("a long silence with the stream attached: the probe never re-attaches, the answer arrives once", async () => {
    const sessionKey = "topic:lag-silent";
    await seedTopic(sessionKey, "t-lag-silent");
    const cli = join(tempDir, "cli-silent.sh");
    // One line, a long think, the rest: the shape of an extended thought or a
    // tool that runs for minutes without a byte.
    writeFileSync(cli, `#!/bin/sh
while read line; do
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"1,"}]}}\\n'
  sleep 6
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"2,"}]}}\\n'
  printf '{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}\\n'
done
`);
    chmodSync(cli, 0o755);
    setEnv("TOPICS_CLAUDE_CLI_PATH", cli);
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    provider.start();
    let resyncs = 0;
    const real = provider.resyncStream.bind(provider);
    provider.resyncStream = (sk: string) => { resyncs++; return real(sk); };
    const sink = counting();
    const turn = provider.sendChat(sessionKey, "go", sink.handler).catch(() => {});
    try {
      const until = Date.now() + 10_000;
      while (sink.deltas < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      // Rounds back to back through the silence: 40 rounds are 160 s of the
      // production cadence, past the 90 s the track asks for.
      for (let round = 0; round < 40 && sink.ended === null; round++) {
        await provider.probeStreamLag();
        await new Promise((r) => setTimeout(r, 100));
      }
      await sink.done;
      await turn;
      expect(sink.ended).toBe("done");
      expect(resyncs).toBe(0);
      expect(sink.text).toBe("1,2,");
    } finally {
      provider.stop();
      try { getAiBridgeClient().kill(sessionKey); } catch { /* gone */ }
    }
  }, 40_000);
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

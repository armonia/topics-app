/**
 * The tail of a broker turn is never lost (T19).
 *
 * Each case drives a REAL ai-bridge daemon and a fake CLI, on the path T18
 * aligned (`claude-code-stream-lag.test.ts`), through the first hole it left:
 *
 *  - B1-B3: the child writes its final text and its `result` while we are
 *    detached, then exits. The daemon's `exit` is a broadcast, so it reaches us
 *    anyway, and the turn used to close on it without the bytes written after
 *    the cut. The daemon keeps the store of a child that exited by itself
 *    (Case 1, "late attach"), so they can be fetched before closing; a killed
 *    child's store is gone, and a daemon older than `endOffset` on the frame
 *    says nothing about a gap.
 * @covers CCLI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-turn-tail-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A kill's daemon grace is 3 s (SIGTERM, then SIGKILL): the close must follow the exit, not wait on anything. */
const KILL_CLOSE_BUDGET_MS = 4_000;

const RESULT = `{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}`;
const text = (t: string) => `{"type":"assistant","message":{"content":[{"type":"text","text":"${t}"}]}}`;

function writeCli(name: string, body: string): string {
  const p = join(tempDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** A CLI that answers with `1,`..`3,`, waits for `gate` to exist, then prints
 *  `final,` and, when `thenResult`, the `result` and exits 0; otherwise it
 *  stays alive with the turn open (B2 kills it; `exec`, so no grandchild holds
 *  stdout open past the kill and the exit follows it at once). */
function gatedCli(name: string, gate: string, thenResult: boolean): string {
  return writeCli(name, `read line
for i in 1 2 3; do printf '%s\\n' '${text("NUM,")}' | sed "s/NUM/$i/"; sleep 0.02; done
while [ ! -f '${gate}' ]; do sleep 0.02; done
printf '%s\\n' '${text("final,")}'
${thenResult ? `printf '%s\\n' '${RESULT}'\nexit 0` : "exec sleep 30"}`);
}

/** A CLI that answers each stdin line with `count` numbered text events, `stepSec` apart, then a `result`. */
function countingCli(name: string, count: number, stepSec: string): string {
  return writeCli(name, `while read line; do
  i=1
  while [ $i -le ${count} ]; do
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' $i
    sleep ${stepSec}
    i=$((i+1))
  done
  printf '%s\\n' '${RESULT}'
done`);
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
  let acc = "";
  let deltas = 0;
  let dones = 0;
  let ended: string | null = null;
  let endedAt = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const end = (how: string) => { ended ??= how; endedAt ||= Date.now(); resolveDone(); };
  const handler: any = {
    onTextDelta: (delta: string) => { acc += delta; deltas++; },
    onToolStart: () => {}, onToolResult: () => {}, onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
    onAborted: (info: any) => end(`aborted:${info?.turnEnd?.cause ?? info?.turnEnd?.end ?? "?"}`),
    onDone: () => { dones++; end("done"); },
    onError: (e: string) => end(`error:${e}`),
  };
  return {
    handler, done,
    get text() { return acc; }, get deltas() { return deltas; }, get dones() { return dones; },
    get ended() { return ended; }, get endedAt() { return endedAt; },
  };
}

function numbersOf(t: string): number[] {
  return t.split(",").filter(Boolean).map(Number);
}

/** Every number once, in order, from 1. */
function expectContiguous(t: string): void {
  const got = numbersOf(t);
  expect(got).toEqual(got.map((_, i) => i + 1));
}

function storeSize(storeDir: string, sessionKey: string): number {
  const p = join(storeDir, `${sessionKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.ndjson`);
  return existsSync(p) ? statSync(p).size : -1;
}

/** Collects console.warn / console.log lines while `fn` runs. */
async function capturing<T>(fn: (said: string[]) => Promise<T>): Promise<T> {
  const said: string[] = [];
  const warn = console.warn;
  const log = console.log;
  console.warn = (...a: unknown[]) => { said.push(a.map(String).join(" ")); warn(...a); };
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); log(...a); };
  try { return await fn(said); } finally { console.warn = warn; console.log = log; }
}

async function newProvider(): Promise<any> {
  const { ClaudeCodeProvider } = await import("./claude-code");
  const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
  provider.start();
  // The probe would close a gap left by a child that is still alive within ~8 s;
  // these cases are about what it cannot reach (a child that exits first) or
  // tick it by hand.
  if (provider.lagProbe) { clearInterval(provider.lagProbe); provider.lagProbe = null; }
  return provider;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-bridge-turn-tail-"));
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
  try { const { closeDatabase } = await import("../db"); closeDatabase(); } catch { /* not opened */ }
  try {
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch { /* gone */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

/** Sends a turn on a gated CLI, waits for its first three numbers, then detaches. */
async function detachedTurn(sessionKey: string, thenResult: boolean) {
  const gate = join(tempDir, `${sessionKey.replace(/\W/g, "_")}.go`);
  setEnv("TOPICS_CLAUDE_CLI_PATH", gatedCli(`${sessionKey.replace(/\W/g, "_")}.sh`, gate, thenResult));
  const provider = await newProvider();
  const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
  const client: any = getAiBridgeClient();
  const sink = counting();
  const turn = provider.sendChat(sessionKey, "go", sink.handler).catch(() => {});
  const until = Date.now() + 10_000;
  while (sink.deltas < 3 && Date.now() < until) await pause(20);
  expect(sink.text).toBe("1,2,3,");
  // The attachment goes, the socket stays: the exit broadcast still reaches us.
  client.detach(sessionKey);
  await pause(100);
  return { provider, client, sink, turn, gate };
}

describe("claude-code provider · the tail of a turn whose child exits while we are detached (B1-B3)", () => {
  test("B1: the final text and the result written after the cut are folded once, the turn ends completed", async () => {
    const sessionKey = "topic:tail-detached";
    await seedTopic(sessionKey, "t-tail-det");
    const { provider, client, sink, turn, gate } = await detachedTurn(sessionKey, true);
    try {
      await capturing(async (said) => {
        const exitAt = Date.now();
        writeFileSync(gate, "");
        await Promise.race([sink.done, pause(5_000)]);
        await turn;
        const pp = provider.processes.get(sessionKey);
        const lag = storeSize(client.storeDir, sessionKey) - (pp?.consumedOffset ?? 0);
        console.log(`[T19 B1] ended ${sink.ended} after ${sink.endedAt - exitAt} ms, text "${sink.text}", onDone x${sink.dones}, unfolded bytes ${lag}`);
        expect(sink.text).toBe("1,2,3,final,");
        expect(sink.ended).toBe("done");
        expect(sink.dones).toBe(1);
        expect(lag).toBe(0);
        expect(said.some((l) => l.includes(`${sessionKey} exited while detached`))).toBe(true);
      });
    } finally {
      provider.stop();
      try { client.kill(sessionKey); } catch { /* gone */ }
    }
  }, 30_000);

  test("B2: the child is killed while we are detached: its store is gone, the turn closes as before and the log says why", async () => {
    const sessionKey = "topic:tail-killed";
    await seedTopic(sessionKey, "t-tail-kill");
    const { provider, client, sink, turn, gate } = await detachedTurn(sessionKey, false);
    try {
      await capturing(async (said) => {
        writeFileSync(gate, "");
        // `final,` is in the store, not with us: there is a tail to lose.
        const until = Date.now() + 5_000;
        while (storeSize(client.storeDir, sessionKey) <= provider.processes.get(sessionKey).consumedOffset && Date.now() < until) await pause(20);
        // Killed by someone else (another server, a sweep): our handlers stay,
        // the daemon unlinks the store as soon as the exit is broadcast.
        const killAt = Date.now();
        expect(client.send({ type: "kill", id: sessionKey })).toBe(true);
        await Promise.race([sink.done, pause(8_000)]);
        await turn;
        console.log(`[T19 B2] ended ${sink.ended} ${sink.endedAt - killAt} ms after the kill, text "${sink.text}"`);
        expect(sink.ended).not.toBeNull();
        expect(sink.ended!.startsWith("error:")).toBe(true); // as before: a signal exit with the turn open
        expect(sink.text).toBe("1,2,3,");
        expect(sink.endedAt - killAt).toBeLessThan(KILL_CLOSE_BUDGET_MS);
        expect(said.some((l) => l.includes(sessionKey) && l.includes("the daemon dropped its store"))).toBe(true);
      });
    } finally {
      provider.stop();
    }
  }, 30_000);

  test("B3: a daemon older than `endOffset` on the exit frame: the turn closes as before, no error", async () => {
    const sessionKey = "topic:tail-old-daemon";
    await seedTopic(sessionKey, "t-tail-old");
    const { provider, client, sink, turn, gate } = await detachedTurn(sessionKey, true);
    const realFrame = client.handleFrame.bind(client);
    client.handleFrame = (m: any) => {
      if (m?.type === "exit") { const { endOffset: _gone, ...old } = m; realFrame(old); } else realFrame(m);
    };
    try {
      await capturing(async (said) => {
        writeFileSync(gate, "");
        await Promise.race([sink.done, pause(5_000)]);
        await turn;
        console.log(`[T19 B3] ended ${sink.ended}, text "${sink.text}"`);
        expect(sink.ended).toBe("aborted:cancelled");
        expect(sink.text).toBe("1,2,3,");
        expect(said.some((l) => l.includes(`${sessionKey} exited while detached`))).toBe(false);
      });
    } finally {
      client.handleFrame = realFrame;
      provider.stop();
      try { client.kill(sessionKey); } catch { /* gone */ }
    }
  }, 30_000);
});

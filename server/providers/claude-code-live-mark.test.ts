/**
 * A RE-ADOPTION REFUSED PAST ITS SCAN LEAVES THE CURSOR EXACT (T19, verification).
 *
 * The server restarts with a turn in flight and re-adopts it. The adopted turn
 * is refused (here a rate limit on the CLI's stderr) with the child alive. The
 * scan had finished, so the cursor stood exactly where the store ended, and yet
 * `finalizeFailedReattach` marked it as left inside the history: the next
 * resync went live, to the store's end, past bytes that were no history at all.
 * When a turn later lost its attach, it lost its own tail, `result` included.
 *
 * Three turns hit it, one test each:
 *  - the next healthy turn the person sends ("a1,a2," instead of "a1,a2,a3,");
 *  - the refused turn itself, going on after the 529 as a woken turn;
 *  - the same turn silent through its API retry when the attach is lost: its
 *    whole answer went, its `result` never folded, and the next send waited on
 *    a CLI turn that never ended.
 * Two earlier fixes spent the mark sooner (when the next send starts, then at
 * the first frame folded); the independent verifier refuted both, with the
 * second and the third. Only a scan cut short marks the cursor now.
 *
 * And a fourth, on the same boundary: the re-adoption's rewind attach capped
 * after it had dropped live frames (they wait for its replay). The next live
 * frame was folded past them and the late replay fell below the cursor: 37
 * numbers out of 380 never reached the row. A rewind given up now owes them.
 *
 * Red on the code before. The scenarios and the CLI are the verifier's.
 *
 * @covers CCLI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-live-mark-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};
// The first value only: a second call for the same key (one CLI script per scenario) must not make the
// restore put back the PREVIOUS scenario's script, a path in a directory that is gone by then.
function setEnv(k: string, v: string) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v; }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESULT = `{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}`;
const text = (t: string) => `{"type":"assistant","message":{"content":[{"type":"text","text":"${t}"}]}}`;

function writeCli(name: string, body: string): string {
  const p = join(tempDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
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
  let received = ""; let deltas = 0; let ended: string | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const end = (how: string) => { ended ??= how; resolveDone(); };
  const handler: any = {
    onTextDelta: (d: string) => { received += d; deltas++; },
    onToolStart: () => {}, onToolResult: () => {}, onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
    onAborted: (info: any) => end(`aborted:${info?.turnEnd?.cause ?? info?.turnEnd?.end ?? "?"}`),
    onDone: () => end("done"),
    onError: (e: string) => end(`error:${e}`),
  };
  return { handler, done, get text() { return received; }, get deltas() { return deltas; }, get ended() { return ended; } };
}
const storeFile = (storeDir: string, sessionKey: string) => join(storeDir, `${sessionKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.ndjson`);
/** The numbers whose line starts at or past `from`, in store order. */
function numbersFrom(store: string, from: number): number[] {
  const out: number[] = [];
  let at = 0;
  for (const line of store.split("\n")) {
    const m = /"text":"(\d+),"/.exec(line);
    if (m && at >= from) out.push(Number(m[1]));
    at += Buffer.byteLength(line) + 1;
  }
  return out;
}
function storeSize(storeDir: string, sessionKey: string): number {
  const p = join(storeDir, `${sessionKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.ndjson`);
  return existsSync(p) ? statSync(p).size : -1;
}
async function newProvider(): Promise<any> {
  const { ClaudeCodeProvider } = await import("./claude-code");
  const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
  provider.start();
  if (provider.lagProbe) { clearInterval(provider.lagProbe); provider.lagProbe = null; }
  return provider;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-bridge-live-mark-"));
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
  try { const { closeDatabase } = await import("../db"); closeDatabase(); } catch { /* */ }
  try {
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch { /* */ }
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Turn 1 in flight across a restart, and its re-adoption refused for a rate
 * limit with the child alive. `turn1Rest` is what the CLI writes once `g(1)`
 * exists, `turn2` its answer to the next message; `G(n)` in them is gate n.
 */
async function refusedReadoption(tag: string, turn1Rest: string, turn2: string) {
  const sessionKey = `topic:live-mark-${tag}`;
  await seedTopic(sessionKey, `t-live-mark-${tag}`);
  const g = (n: number) => join(tempDir, `${tag}.g${n}`);
  const gated = (body: string) => body.replace(/G\((\d)\)/g, (_m, d) => g(Number(d)));
  setEnv("TOPICS_CLAUDE_CLI_PATH", writeCli(`${tag}.sh`, `n=0
while read line; do
  n=$((n+1))
  if [ $n -eq 1 ]; then
    printf '%s\\n' '${text("t1a,")}'
    while [ ! -f '${g(0)}' ]; do sleep 0.02; done
    echo 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}} retrying' >&2
    while [ ! -f '${g(1)}' ]; do sleep 0.02; done
${gated(turn1Rest)}
  else
${gated(turn2)}
  fi
done`));
  const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
  const client: any = getAiBridgeClient();
  // Server 1: turn 1 in flight.
  const first = await newProvider();
  const s1 = counting();
  void first.sendChat(sessionKey, "first", s1.handler).catch(() => {});
  let until = Date.now() + 10_000;
  while (s1.deltas < 1 && Date.now() < until) await pause(20);
  expect(s1.text).toBe("t1a,");
  // Restart.
  first.stop();
  first.processes = new Map();
  const second = await newProvider();
  const sr = counting();
  const reattached = second.reattach(sessionKey, sr.handler);
  const pp = () => second.processes.get(sessionKey);
  until = Date.now() + 10_000;
  while (!(pp()?.streamHandler === sr.handler && !pp()?.replaySilent) && Date.now() < until) await pause(20);
  await pause(200);
  // The CLI reports an overload on stderr and keeps working on the turn for more than 10 s.
  writeFileSync(g(0), "");
  await Promise.race([sr.done, pause(14_000)]);
  await reattached;
  expect(sr.ended, "the adopted turn is refused for the rate limit").toContain("RATE_LIMIT");
  return { sessionKey, client, second, pp, g };
}

/** The attach is lost (the socket stays), the CLI writes past gate `n` to the store only, and the lag probe sees the gap twice. */
async function loseAttachThenProbe(ctx: Awaited<ReturnType<typeof refusedReadoption>>, n: number) {
  const { sessionKey, client, second, pp, g } = ctx;
  client.detach(sessionKey);
  await pause(100);
  writeFileSync(g(n), "");
  const until = Date.now() + 5_000;
  while (storeSize(client.storeDir, sessionKey) <= pp().consumedOffset && Date.now() < until) await pause(20);
  await pause(200);
  await second.probeStreamLag(); await second.probeStreamLag();
}

describe("claude-code provider · a re-adoption refused past its scan", () => {
  test("the next turn, losing its attach, still gets its whole answer", async () => {
    const ctx = await refusedReadoption("next-turn",
      `    printf '%s\\n' '${text("t1b,")}' '${RESULT}'`,
      `    printf '%s\\n' '${text("a1,")}' '${text("a2,")}'
    while [ ! -f 'G(2)' ]; do sleep 0.02; done
    printf '%s\\n' '${text("a3,")}' '${RESULT}'`);
    const { sessionKey, client, second, pp, g } = ctx;
    try {
      // The CLI ends the refused turn, folded with no handler.
      writeFileSync(g(1), "");
      let until = Date.now() + 5_000;
      while (pp().consumedOffset < storeSize(client.storeDir, sessionKey) && Date.now() < until) await pause(20);
      await pause(300);
      // Turn 2, a healthy one on the same child.
      const child = pp();
      const s2 = counting();
      void second.sendChat(sessionKey, "second", s2.handler).catch(() => {});
      until = Date.now() + 10_000;
      while (s2.deltas < 2 && Date.now() < until) await pause(20);
      expect(s2.text).toBe("a1,a2,");
      expect(pp()).toBe(child);
      await loseAttachThenProbe(ctx, 2);
      await Promise.race([s2.done, pause(3_000)]);
      expect(s2.text).toBe("a1,a2,a3,");
      expect(s2.ended).toBe("done");
    } finally {
      second.stop();
      try { client.kill(sessionKey); } catch { /* the child may be gone already */ }
    }
  }, 60_000);

  test("the refused turn, going on as a woken turn, gets its tail when its attach is lost", async () => {
    const { ClaudeCodeProvider } = await import("./claude-code");
    const ctx = await refusedReadoption("woken",
      `    printf '%s\\n' '${text("t1b,")}'
    while [ ! -f 'G(2)' ]; do sleep 0.02; done
    printf '%s\\n' '${text("t1c,")}' '${RESULT}'`,
      `    printf '%s\\n' '${text("x,")}' '${RESULT}'`);
    const { sessionKey, client, second, g } = ctx;
    const wake = counting();
    // The route adopts the wake into a row of its own.
    ClaudeCodeProvider.observeWokenTurns((sk) => sk === sessionKey && second.adoptWokenTurn(sk, wake.handler));
    try {
      writeFileSync(g(1), "");
      const until = Date.now() + 5_000;
      while (wake.deltas < 1 && Date.now() < until) await pause(20);
      expect(wake.text).toBe("t1b,");
      await loseAttachThenProbe(ctx, 2);
      await Promise.race([wake.done, pause(3_000)]);
      expect(wake.text).toBe("t1b,t1c,");
      expect(wake.ended).toBe("done");
    } finally {
      ClaudeCodeProvider.observeWokenTurns(() => false);
      second.stop();
      try { client.kill(sessionKey); } catch { /* the child may be gone already */ }
    }
  }, 60_000);

  test("the refused turn, silent in its retry when its attach is lost, keeps its answer, and the next send goes", async () => {
    const { ClaudeCodeProvider } = await import("./claude-code");
    const ctx = await refusedReadoption("quiet",
      `    printf '%s\\n' '${text("t1b,")}' '${text("t1c,")}' '${RESULT}'`,
      `    printf '%s\\n' '${text("x,")}' '${RESULT}'`);
    const { sessionKey, client, second } = ctx;
    const wake = counting();
    ClaudeCodeProvider.observeWokenTurns((sk) => sk === sessionKey && second.adoptWokenTurn(sk, wake.handler));
    try {
      // Nothing has folded since the refusal: the CLI is in its API retry. The attach is lost, then the retry ends.
      await loseAttachThenProbe(ctx, 1);
      await Promise.race([wake.done, pause(2_000)]);
      expect(wake.text).toBe("t1b,t1c,");
      expect(wake.ended).toBe("done");
      // The person writes again: the CLI's turn is over, so the message reaches it.
      const next = counting();
      void second.sendChat(sessionKey, "again", next.handler).catch(() => {});
      await Promise.race([next.done, pause(5_000)]);
      expect(next.text).toBe("x,");
      expect(next.ended).toBe("done");
    } finally {
      ClaudeCodeProvider.observeWokenTurns(() => false);
      second.stop();
      try { client.kill(sessionKey); } catch { /* the child may be gone already */ }
    }
  }, 60_000);

  test("a rewind capped after it dropped live frames owes them: the turn going on gets every number", async () => {
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient, BridgeAckStalled } = await import("../lib/ai-bridge-client");
    const sessionKey = "topic:live-mark-rewind-capped";
    await seedTopic(sessionKey, "t-live-mark-rewind-capped");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeCli("rewind-capped.sh", `while read line; do
  i=1
  while [ $i -le 400 ]; do printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' $i; sleep 0.005; i=$((i+1)); done
  printf '%s\\n' '${RESULT}'
done`));
    const client: any = getAiBridgeClient();
    // Server 1: the CLI writes a number every 5 ms.
    const first = await newProvider();
    const s1 = counting();
    void first.sendChat(sessionKey, "go", s1.handler).catch(() => {});
    let until = Date.now() + 10_000;
    while (s1.deltas < 20 && Date.now() < until) await pause(10);
    first.stop();
    first.processes = new Map();
    const second = await newProvider();
    // The re-adoption's second attach (the rewind) goes out while the pipe from the daemon is congested: our live
    // frames keep arriving for 300 ms and are dropped (the rewind waits), then the pipe backs up, the daemon reads
    // the attach late, and the ack waiter hits its cap, which keeps the socket. The backlog drains after.
    const realAttach = client.attach.bind(client);
    const realFrame = client.handleFrame.bind(client);
    let held: any[] | null = null;
    client.handleFrame = (m: any) => { if (held && m?.id === sessionKey) { held.push(m); return; } realFrame(m); };
    let attaches = 0;
    let scanEnd = -1;
    client.attach = async (id: string, from: number, attempts?: number) => {
      if (id === sessionKey && ++attaches === 2) {
        scanEnd = second.processes.get(sessionKey).consumedOffset;
        await pause(300);
        held = [];
        await pause(60);
        realAttach(id, from, attempts).catch(() => {});
        await pause(60);
        throw new BridgeAckStalled(`ai-bridge: ack timeout (attach ${id}, cap 90s)`, false);
      }
      return realAttach(id, from, attempts);
    };
    const wake = counting();
    ClaudeCodeProvider.observeWokenTurns((sk) => sk === sessionKey && second.adoptWokenTurn(sk, wake.handler));
    try {
      await second.reattach(sessionKey, counting().handler);
      client.attach = realAttach;
      const backlog = held ?? [];
      held = null;
      for (const m of backlog) realFrame(m);
      until = Date.now() + 10_000;
      while (wake.ended === null && Date.now() < until) await pause(20);
      await pause(300);
      const owed = numbersFrom(readFileSync(storeFile(client.storeDir, sessionKey), "utf8"), scanEnd);
      const got = wake.text.split(",").filter(Boolean).map(Number);
      expect(wake.ended).toBe("done");
      expect(owed.length, "the turn went on past the scan").toBeGreaterThan(100);
      expect(owed.filter((n) => !got.includes(n)), "numbers past the scan that never reached the row").toEqual([]);
    } finally {
      client.attach = realAttach;
      client.handleFrame = realFrame;
      held = null;
      ClaudeCodeProvider.observeWokenTurns(() => false);
      second.stop();
      try { client.kill(sessionKey); } catch { /* the child may be gone already */ }
    }
  }, 60_000);
});

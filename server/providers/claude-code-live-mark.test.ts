/**
 * THE MARK A FAILED RE-ADOPTION LEAVES ENDS AT THE FIRST FRAME FOLDED AFTER IT
 * (T19, verification).
 *
 * The server restarts with a turn in flight and re-adopts it. The adopted turn
 * is refused (here a rate limit on the CLI's stderr) with the child alive, and
 * `finalizeFailedReattach` leaves `reattachLive`: the next resync goes to the
 * store's end. Nothing spent the mark while the frames after it were folded, so
 * it outlived them, and the first resync of a turn that later lost its attach
 * jumped past that turn's own tail, `result` included. The answer came out cut
 * and the row hung until the watchdog.
 *
 * Two turns hit it, one test each:
 *  - the next healthy turn the person sends ("a1,a2," instead of "a1,a2,a3,");
 *  - the refused turn itself, going on after the 529 as a woken turn. That one
 *    is no send of ours, which is why spending the mark when a send starts was
 *    not enough.
 *
 * Both are red on the code before `admitFrame` spent the mark. The scenarios
 * and the CLI are the independent verifier's.
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
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }
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
  expect(pp().reattachLive, "and the failed re-adoption leaves its mark").toBe(true);
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

describe("claude-code provider · the mark a failed re-adoption leaves", () => {
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
});

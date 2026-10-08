/**
 * A FAILED RE-ADOPTION'S LIVE MARK ENDS AT THE NEXT TURN (T19, verification).
 *
 * The server restarts with a turn in flight and re-adopts it. The adopted turn is
 * refused (here a rate limit on the CLI's stderr), with the child alive and our
 * cursor already at the end of its store: `finalizeFailedReattach` leaves
 * `reattachLive`, and nothing spent it, since the lag probe sees no gap. The next
 * turn, a healthy one on the same child, loses its attach halfway: its first
 * resync went live, to the store's end, past the turn's own tail and `result`.
 * The answer came out "a1,a2," and the turn hung until the watchdog.
 *
 * Red before `spendLiveMark`; green after, with the probe's ordinary resync
 * recovering the tail. The scenario and the CLI are the independent verifier's.
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
  let received = ""; let deltas = 0; let dones = 0; let ended: string | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const end = (how: string) => { ended ??= how; resolveDone(); };
  const handler: any = {
    onTextDelta: (d: string) => { received += d; deltas++; },
    onToolStart: () => {}, onToolResult: () => {}, onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
    onAborted: (info: any) => end(`aborted:${info?.turnEnd?.cause ?? info?.turnEnd?.end ?? "?"}`),
    onDone: () => { dones++; end("done"); },
    onError: (e: string) => end(`error:${e}`),
  };
  return { handler, done, get text() { return received; }, get deltas() { return deltas; }, get dones() { return dones; }, get ended() { return ended; } };
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

async function scenario(tag: string) {
  const sessionKey = `topic:live-mark-${tag}`;
  await seedTopic(sessionKey, `t-live-mark-${tag}`);
  const g = (n: number) => join(tempDir, `${tag}.g${n}`);
  setEnv("TOPICS_CLAUDE_CLI_PATH", writeCli(`${tag}.sh`, `n=0
while read line; do
  n=$((n+1))
  if [ $n -eq 1 ]; then
    printf '%s\\n' '${text("t1a,")}'
    while [ ! -f '${g(0)}' ]; do sleep 0.02; done
    echo 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}} retrying' >&2
    while [ ! -f '${g(1)}' ]; do sleep 0.02; done
    printf '%s\\n' '${text("t1b,")}' '${RESULT}'
  else
    printf '%s\\n' '${text("a1,")}' '${text("a2,")}'
    while [ ! -f '${g(2)}' ]; do sleep 0.02; done
    printf '%s\\n' '${text("a3,")}' '${RESULT}'
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
  // The CLI reports an overload on stderr and keeps working on the turn > 10 s.
  writeFileSync(g(0), "");
  await Promise.race([sr.done, pause(14_000)]);
  await reattached;
  // The CLI ends turn 1 (folded with no handler).
  writeFileSync(g(1), "");
  until = Date.now() + 5_000;
  while (pp().consumedOffset < storeSize(client.storeDir, sessionKey) && Date.now() < until) await pause(20);
  await pause(300);
  // Production's probe ticks every 4 s: the cursor is at the end, so nothing consumes the flag.
  await second.probeStreamLag(); await second.probeStreamLag(); await second.probeStreamLag();
  const stickyBeforeTurn2 = pp().reattachLive === true;
  // Turn 2, a healthy turn on the same child.
  const ppBefore = pp();
  const s2 = counting();
  const t2 = second.sendChat(sessionKey, "second", s2.handler).catch((e: any) => `rejected:${e?.message}`);
  until = Date.now() + 10_000;
  while (s2.deltas < 2 && Date.now() < until) await pause(20);
  expect(s2.text).toBe("a1,a2,");
  expect(pp()).toBe(ppBefore);
  // The attachment is lost (socket stays): the CLI writes a3 and the result to the store only.
  client.detach(sessionKey);
  await pause(100);
  writeFileSync(g(2), "");
  until = Date.now() + 5_000;
  while (storeSize(client.storeDir, sessionKey) <= pp().consumedOffset && Date.now() < until) await pause(20);
  await pause(200);
  // The lag probe: two sightings of the same gap, the second re-attaches.
  await second.probeStreamLag(); await second.probeStreamLag();
  await Promise.race([s2.done, pause(3_000)]);
  const res = { stickyBeforeTurn2, ended: s2.ended, text: s2.text };
  second.stop();
  try { client.kill(sessionKey); } catch { /* */ }
  void t2;
  return res;
}

describe("claude-code provider · the live mark a failed re-adoption leaves", () => {
  test("is spent when the next turn starts: a healthy turn that loses its attach gets its whole tail", async () => {
    const r = await scenario("next-turn");
    expect(r.stickyBeforeTurn2, "the re-adoption failed and left the mark, as in production").toBe(true);
    expect(r.text).toBe("a1,a2,a3,");
    expect(r.ended).toBe("done");
  }, 60_000);
});

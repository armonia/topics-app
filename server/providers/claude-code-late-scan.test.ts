/**
 * A RE-ADOPTION WHOSE SCAN HITS THE CAP WAITS FOR ITS LATE ACK.
 *
 * Under load at boot the scan of a re-adoption (a muted replay of the whole
 * store, from 0) can outlast the 90 s cap while its bytes are still arriving.
 * The cap gave up, the re-adoption failed ("Riadozione del turno non riuscita",
 * 60 times in the production log), and the replay went on arriving on the same
 * socket. Unmuted by then, it folded as a turn nobody had asked for: the wake
 * observer opened a row and every old answer of the session came back in it.
 * The verifier found it in T19 (the B4b family) and it was there on main too.
 *
 * The daemon writes the ack right behind that replay, so the scan now waits for
 * it, muted, and the re-adoption goes on as if the ack had been on time: a
 * finished turn closes, an open one is replayed whole into its own row.
 *
 * The daemon and the CLI are real; only the cap is staged, at the attach: the
 * daemon gets the attach and starts its replay, the waiter gives up at once.
 *
 * @covers CCLI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-late-scan-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESULT = `{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}`;
/** An assistant line whose text is `<printf %d>,`, for a shell loop. */
const NUMBERED = `{"type":"assistant","message":{"content":[{"type":"text","text":"%d,"}]}}`;

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
  const end = (how: string) => { ended ??= how; };
  const handler: any = {
    onTextDelta: (d: string) => { received += d; deltas++; },
    onToolStart: () => {}, onToolResult: () => {}, onSubAgentUpdate: () => {}, onUserInputRequired: () => {},
    onAborted: (info: any) => end(`aborted:${info?.turnEnd?.cause ?? info?.turnEnd?.end ?? "?"}`),
    onDone: () => end("done"),
    onError: (e: string) => end(`error:${e}`),
  };
  return { handler, get text() { return received; }, get deltas() { return deltas; }, get ended() { return ended; } };
}
const nums = (t: string) => t.split(",").filter(Boolean).map(Number);
const storeFile = (storeDir: string, sessionKey: string) => join(storeDir, `${sessionKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.ndjson`);
async function newProvider(): Promise<any> {
  const { ClaudeCodeProvider } = await import("./claude-code");
  const provider: any = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
  provider.start();
  if (provider.lagProbe) { clearInterval(provider.lagProbe); provider.lagProbe = null; }
  return provider;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-bridge-late-scan-"));
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
  const { ClaudeCodeProvider } = await import("./claude-code");
  ClaudeCodeProvider.observeWokenTurns(() => false);
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
 * The server restarts while the CLI of `sessionKey` lives on; the new provider
 * re-adopts with its scan capped (`capped` counts it) and every wake recorded.
 * `firstTurn` drives the old provider until the restart.
 */
async function restartWithScanCapped(sessionKey: string, firstTurn: (p: any) => Promise<void>) {
  const { ClaudeCodeProvider } = await import("./claude-code");
  const { getAiBridgeClient, BridgeAckStalled } = await import("../lib/ai-bridge-client");
  const client: any = getAiBridgeClient();
  const first = await newProvider();
  await firstTurn(first);
  first.stop(); first.processes = new Map();

  const second = await newProvider();
  const wakes: string[] = [];
  const woken = counting();
  ClaudeCodeProvider.observeWokenTurns((sk: string) => {
    if (sk !== sessionKey) return false;
    wakes.push(sk);
    return second.adoptWokenTurn(sk, woken.handler);
  });
  const realAttach = client.attach.bind(client);
  let capped = 0;
  client.attach = (id: string, from: number, attempts?: number) => {
    if (id !== sessionKey || capped > 0) return realAttach(id, from, attempts);
    capped++;
    // The daemon has the attach and its replay is on the way; the waiter gives up at the cap.
    const reply = realAttach(id, from, attempts).catch(() => null);
    return Promise.reject(new BridgeAckStalled(`ai-bridge: ack timeout (attach ${id}, tetto 90s)`, false, reply));
  };
  const row = counting();
  const done = () => {
    client.attach = realAttach;
    ClaudeCodeProvider.observeWokenTurns(() => false);
    second.stop();
    try { client.kill(sessionKey); } catch { /* already gone */ }
  };
  return { client, second, row, wakes, woken, done, get capped() { return capped; } };
}

describe("claude-code provider · a re-adoption whose scan hits the cap", () => {
  test("with the turn finished: it closes, and no old answer comes back as a woken turn", async () => {
    const sessionKey = "topic:late-scan-done";
    await seedTopic(sessionKey, "t-late-scan-done");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeCli("late-done.sh", `n=0
while read line; do
  n=$((n+1)); printf '${NUMBERED}\\n' $((n*10+1)); printf '${NUMBERED}\\n' $((n*10+2)); printf '%s\\n' '${RESULT}'
done`));
    const s = await restartWithScanCapped(sessionKey, async (first) => {
      const t1 = counting();
      await first.sendChat(sessionKey, "first", t1.handler);
      expect(t1.text).toBe("11,12,");
    });
    try {
      const outcome = await s.second.reattach(sessionKey, s.row.handler);
      await pause(500);
      expect(s.capped).toBe(1);
      expect(outcome).toBe("completed");
      expect(s.row.ended).not.toStartWith("error");
      expect(s.wakes).toEqual([]);
      expect(s.woken.text).toBe("");
      // The session goes on: the next message gets its own answer, only that.
      const t2 = counting();
      await s.second.sendChat(sessionKey, "second", t2.handler);
      expect(t2.text).toBe("21,22,");
      expect(s.wakes).toEqual([]);
    } finally { s.done(); }
  }, 60_000);

  test("mid-turn: the turn comes into its own row whole, once the late ack lands", async () => {
    const sessionKey = "topic:late-scan-open";
    await seedTopic(sessionKey, "t-late-scan-open");
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeCli("late-open.sh", `while read line; do
  i=1
  while [ $i -le 300 ]; do printf '${NUMBERED}\\n' $i; sleep 0.005; i=$((i+1)); done
  printf '%s\\n' '${RESULT}'
done`));
    const s = await restartWithScanCapped(sessionKey, async (first) => {
      const t1 = counting();
      void first.sendChat(sessionKey, "go", t1.handler).catch(() => {});
      const until = Date.now() + 10_000;
      while (t1.deltas < 20 && Date.now() < until) await pause(10);
    });
    try {
      const outcome = await s.second.reattach(sessionKey, s.row.handler);
      expect(s.capped).toBe(1);
      expect(outcome).toBe("live");
      expect(s.row.ended).toBe("done");
      const store = readFileSync(storeFile(s.client.storeDir, sessionKey), "utf8");
      const written = nums(store.split("\n").map((l) => /"text":"(\d+),"/.exec(l)?.[1]).filter(Boolean).join(","));
      expect(written.length).toBe(300);
      expect(nums(s.row.text)).toEqual(written);
      expect(s.wakes).toEqual([]);
    } finally { s.done(); }
  }, 60_000);
});

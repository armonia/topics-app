/**
 * THE ROUTE WAITS FOR A RE-ADOPTION THAT IS STILL SCANNING.
 *
 * A re-adoption's scan that hits the 90 s cap waits for its late ack (CCLI-04),
 * and under load that wait can outlast the route's silence budget (soft + grace,
 * 60 s + 60 s). The route's grace watchdog asks `isTurnProcessAlive`, and a scan
 * has no stream handler yet: the answer was «dead», so the route closed the row
 * as timed out and sent `abort(..., "watchdog")`, a SIGINT to the very CLI turn
 * the late ack was about to adopt. Before the wait existed the cap came first
 * (90 s < 120 s) and the turn ran to its end. The verifier found it.
 *
 * The scan now counts as alive for the route, and no resync stacks a second
 * replay behind its own: the route extends, the late ack lands, and the turn
 * comes into its row whole while the CLI finishes it.
 *
 * Scaled: the cap is staged at the attach (as in claude-code-late-scan.test.ts),
 * soft and grace are 1 s each (the route's own env knobs), the late ack comes
 * 3.5 s later. Real route, real ClaudeCodeProvider, real ai-bridge daemon.
 *
 * @covers CCLI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tempDir = "";
/** The test's own data root (`setupTestDataDir`), put back in `afterAll`. */
let dataRoot = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }
const RESULT = `{"type":"result","result":"FINAL-RESULT","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}`;
/** An assistant line whose text is `<printf %d>,`, for a shell loop. */
const NUMBERED = `{"type":"assistant","message":{"content":[{"type":"text","text":"%d,"}]}}`;
const N = 400;
const LATE_MS = 3500;

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "late-scan-route-grace-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempDir, "ai-bridge.sock"));
  // The old server's stream keeps production windows: its timers outlive the in-process "shutdown".
  setEnv("TOPICS_STREAM_SOFT_MS", "600000");
  setEnv("TOPICS_STREAM_GRACE_MS", "600000");
  const cli = join(tempDir, "cli.sh");
  // SIGINT ends the child, as the real CLI does in stream-json mode (exit 0).
  writeFileSync(cli, `#!/bin/sh
trap 'exit 0' INT
while read line; do
  i=1
  while [ $i -le ${N} ]; do printf '${NUMBERED}\\n' $i; sleep 0.02; i=$((i+1)); done
  printf '%s\\n' '${RESULT}'
done
`);
  chmodSync(cli, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", cli);
});

afterAll(async () => {
  try { const { getProvider } = await import("../../server/providers"); (getProvider("claude-code") as { stop?: () => void } | undefined)?.stop?.(); } catch { /* already gone */ }
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  const pidFile = join(tempDir, "ai-bridge.pid");
  try { if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGTERM"); } catch { /* already gone */ }
  if (dataRoot) {
    const { cleanupTestDataDir } = await import("./helpers");
    cleanupTestDataDir(dataRoot);
  }
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

async function waitFor(what: string, check: () => boolean, ms = 20_000): Promise<void> {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(50)) if (check()) return;
  throw new Error(`timed out waiting for ${what}`);
}
const nums = (text: string) => text.split(",").filter(Boolean).map(Number);

describe("a re-adoption's scan past the route's silence budget", () => {
  test("the route waits for the late ack: the CLI finishes its turn and the row gets it whole", async () => {
    const { setupTestDataDir, createTestAppContext, testTmpDir } = await import("./helpers");
    dataRoot = testTmpDir("late-scan-route-grace");
    setupTestDataDir(dataRoot);
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const { registerProvider, removeProvider } = await import("../../server/providers");
    const { __resetAiBridgeClientForTests, getAiBridgeClient, BridgeAckStalled } = await import("../../server/lib/ai-bridge-client");
    const ctx = await createTestAppContext();
    const frames: Array<{ type?: string; stopCause?: string }> = [];
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => frames.push(m as { type?: string });
    (ctx as { broadcastToTopicSubscribers: (i: string, m: unknown) => void }).broadcastToTopicSubscribers = (_i, m) => frames.push(m as { type?: string });
    const sk = "topic:lategrace";
    ctx.saveSingleTopic({ id: "lategrace-0000-0000-0000-000000000000", name: "late", slug: "late", parentId: null, links: [], sessionKey: sk, color: "#5865f2",
      icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, provider: "claude-code" } as never);
    const post = async (router: ReturnType<typeof createTopicsRouter>, body: Record<string, unknown>) => {
      const url = new URL("http://localhost/api/chat");
      const resp = await router(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk, ...body }) }), url, "/api/chat", "POST") as Response;
      expect(resp.status).toBe(200);
      const reader = resp.body!.getReader();
      return (async () => { try { while (!(await reader.read()).done) { /* drained */ } } catch { /* cut */ } })();
    };
    const rows = () => ctx.db.query("SELECT id, role, content, partial FROM messages WHERE session_key = ? ORDER BY sort_order").all(sk) as Array<{ id: string; role: string; content: string; partial: number }>;
    const store = () => join(getAiBridgeClient().storeDir, `${sk.replace(/[^a-zA-Z0-9_-]/g, "_")}.ndjson`);
    const numbersIn = (path: string) => readFileSync(path, "utf8").match(/"text":"\d+,"/g)?.length ?? 0;

    // The old server: the turn starts and runs.
    const provider1 = registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never) as { stop: () => void };
    void post(createTopicsRouter(ctx), { messages: [{ role: "user", content: "go" }] });
    await waitFor("20 numbers in the store", () => existsSync(store()) && numbersIn(store()) >= 20);
    const storePath = store();
    // Shutdown: the provider detaches and the server goes; the CLI lives on in the daemon.
    provider1.stop();
    removeProvider("claude-code");
    __resetAiBridgeClientForTests();
    ctx.activeStreams.delete(sk);

    // The boot: a fresh provider whose scan hits the cap at the attach; the daemon's ack comes LATE_MS later.
    registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never);
    const client: any = getAiBridgeClient();
    const realAttach = client.attach.bind(client);
    let capped = 0;
    let lateSent = false;
    const stacked: number[] = [];
    client.attach = (id: string, from: number, attempts?: number) => {
      if (id === sk && capped > 0 && !lateSent) stacked.push(from);
      if (id !== sk || capped > 0) return realAttach(id, from, attempts);
      capped++;
      const reply = Bun.sleep(LATE_MS).then(() => { lateSent = true; return realAttach(id, from, attempts); }).catch(() => null);
      return Promise.reject(new BridgeAckStalled(`ai-bridge: ack timeout (attach ${id}, tetto 90s)`, false, reply));
    };
    // In production the capped attach went out on this socket: it is connected.
    await client.ensureConnected();
    // The boot's route, its windows scaled down (production: 60 s + 60 s, past the 90 s cap).
    process.env.TOPICS_STREAM_SOFT_MS = "1000";
    process.env.TOPICS_STREAM_GRACE_MS = "1000";
    const drained = post(createTopicsRouter(ctx), { messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
    try {
      await waitFor("the adopted row to close", () => rows().every((r) => r.partial === 0), 30_000);
      await drained.catch(() => {});
      expect(capped).toBe(1);
      // No resync stacked a replay behind the scan's while it waited: folded into the muted scan, an old
      // `result` in it would rewrite the tail the re-adoption decides on.
      expect(stacked).toEqual([]);
      // The CLI was not stopped: its turn ran to the end in the store.
      expect(numbersIn(storePath)).toBe(N);
      expect(readFileSync(storePath, "utf8")).toContain("FINAL-RESULT");
      expect(frames.filter((f) => f.type === "stream:end" && f.stopCause === "watchdog")).toEqual([]);
      // And the row got that turn whole, once: not a timeout notice over a fragment.
      const answer = rows().filter((r) => r.role === "assistant").pop()?.content ?? "";
      expect(answer).not.toContain("timed out");
      expect(nums(answer)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    } finally {
      client.attach = realAttach;
      try { client.kill(sk); } catch { /* already gone */ }
    }
  }, 90_000);
});

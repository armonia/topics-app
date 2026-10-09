/**
 * Two more scenarios of `late-scan-past-cap.test.ts`, found by the third verification of PR #268. Each runs
 * in a child `bun test` of its own (`LATE_SCAN_CASE`), with the caps scaled down as there, against the real
 * daemon and a real store:
 *  - `probe`: at boot, a session whose partial row is gone is first probed (`brokerTurnState` with `park`,
 *    `reattachSurvivors`), and that probe's scan is the re-adoption's phase 1. Behind a 20 MB replay it failed
 *    at the cap: `unknown`, and the boot left the open turn alone until the next boot;
 *  - `exit-grace`: two re-adoptions at once, as at a boot. A's 52 MB store is the backlog, and B's CLI finishes
 *    and exits while it drains. B was no longer alive while its tail waited behind A's replay, and the route's
 *    grace (1 s + 1 s here) closed B's row as a timeout with 0 numbers out of 400.
 */
process.env.TOPICS_AI_BRIDGE_ATTACH_ACK_MS ??= "300";
process.env.TOPICS_AI_BRIDGE_MAX_ACK_MS ??= "300";
process.env.TOPICS_AI_BRIDGE_STALL_TICK_MS ??= "25";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync, writeFileSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tempDir = "";
let dataRoot = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }
const CASE = process.env.LATE_SCAN_CASE ?? "probe";
/** The fat lines (2 KB each) of the turn that makes the backlog: ~20 MB for the probe, ~52 MB for A. */
const FAST = CASE === "probe" ? 10_000 : 25_000;
/** The lines of B's turn, the one that exits while A's backlog drains. */
const B_LINES = 400;

beforeAll(async () => {
  if (CASE !== "probe" && CASE !== "exit-grace") throw new Error(`unknown LATE_SCAN_CASE ${CASE}`);
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "late-scan-boot-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempDir, "ai-bridge.sock"));
  setEnv("TOPICS_STREAM_SOFT_MS", "600000");
  setEnv("TOPICS_STREAM_GRACE_MS", "600000");
  const cli = join(tempDir, "cli.sh");
  const line = `printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' $i`;
  // B writes 50 lines, waits for the test's signal, writes the rest and exits. Any other turn writes the fat
  // part, then one thin line every 50 ms: still open whenever it is probed or re-adopted.
  writeFileSync(cli, `#!/bin/sh
trap 'exit 0' INT
PAD=$(head -c 2000 /dev/zero | tr '\\0' 'x')
while read line; do
  i=1
  case "$line" in
    *go-B*)
      while [ $i -le 50 ]; do ${line}; i=$((i+1)); done
      while [ ! -f ${join(tempDir, "exit")} ]; do sleep 0.01; done
      while [ $i -le ${B_LINES} ]; do ${line}; i=$((i+1)); done
      printf '%s\\n' '{"type":"result","result":"FINAL-B","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}'
      exit 0;;
    *)
      while [ $i -le ${FAST} ]; do printf '{"type":"assistant","pad":"%s","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' "$PAD" $i; i=$((i+1)); done
      while [ $i -le 99999 ]; do ${line}; sleep 0.05; i=$((i+1)); done;;
  esac
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

async function waitFor(what: string, check: () => boolean, ms = 60_000): Promise<void> {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(50)) if (check()) return;
  throw new Error(`timed out waiting for ${what}`);
}
const nums = (text: string) => text.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);

async function setup(label: string) {
  const { setupTestDataDir, createTestAppContext, testTmpDir } = await import("./helpers");
  dataRoot = testTmpDir(label);
  setupTestDataDir(dataRoot);
  const { createTopicsRouter } = await import("../../server/routes/topics");
  const providers = await import("../../server/providers");
  const bridge = await import("../../server/lib/ai-bridge-client");
  const ctx = await createTestAppContext();
  const frames: Array<{ type?: string; sessionKey?: string; stopCause?: string }> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => frames.push(m as never);
  (ctx as { broadcastToTopicSubscribers: (i: string, m: unknown) => void }).broadcastToTopicSubscribers = (_i, m) => frames.push(m as never);
  const topic = (sk: string) => ctx.saveSingleTopic({ id: `${sk.slice(6)}-0000-0000-0000-000000000000`, name: sk, slug: sk.slice(6), parentId: null, links: [],
    sessionKey: sk, color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false,
    provider: "claude-code" } as never);
  const post = async (sk: string, body: Record<string, unknown>) => {
    const url = new URL("http://localhost/api/chat");
    const resp = await createTopicsRouter(ctx)(new Request(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: sk, ...body }) }), url, "/api/chat", "POST") as Response;
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    return (async () => { try { while (!(await reader.read()).done) { /* drained */ } } catch { /* cut */ } })();
  };
  const rows = (sk: string) => ctx.db.query("SELECT id, role, content, partial FROM messages WHERE session_key = ? ORDER BY sort_order").all(sk) as
    Array<{ id: string; role: string; content: string; partial: number }>;
  const store = (sk: string) => join(bridge.getAiBridgeClient().storeDir, `${sk.replace(/[^a-zA-Z0-9_-]/g, "_")}.ndjson`);
  const provider1 = providers.registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never) as { stop: () => void };
  /** The server goes down with its turns still running in the daemon; a fresh provider and client come up. */
  const restart = (keys: string[]) => {
    provider1.stop();
    providers.removeProvider("claude-code");
    bridge.__resetAiBridgeClientForTests();
    for (const sk of keys) ctx.activeStreams.delete(sk);
    return providers.registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never);
  };
  return { frames, topic, post, rows, store, restart, client: () => bridge.getAiBridgeClient() as any };
}

if (CASE === "probe") {
  test("at boot, the probe of a session with no partial row sees the turn open behind a 20 MB replay, past the cap", async () => {
    const { topic, post, store, restart, client } = await setup("late-scan-probe");
    const sk = "topic:probecap";
    topic(sk);
    void post(sk, { messages: [{ role: "user", content: "go" }] });
    await waitFor("the fat part in the store", () => existsSync(store(sk)) && statSync(store(sk)).size >= FAST * 2080);
    const storePath = store(sk);
    const provider2 = restart([sk]) as unknown as { brokerTurnState: (sk: string, o?: { park?: boolean }) => Promise<string> };
    await client().ensureConnected();
    try {
      const t0 = Date.now();
      // `reattachSurvivors`' branch for a session whose partial row is gone.
      const says = await provider2.brokerTurnState(sk, { park: true });
      console.log(`[late-scan-boot:probe] brokerTurnState(park) = ${says} after ${Date.now() - t0} ms; store ${statSync(storePath).size} bytes`);
      expect(readFileSync(storePath, "utf8")).not.toContain('"type":"result"');
      expect(says).toBe("open");
    } finally {
      try { client().kill(sk); } catch { /* already gone */ }
    }
  }, 180_000);
}

if (CASE === "exit-grace") {
  test("a CLI that exits while another session's backlog drains: the route waits for its tail, and the row is whole", async () => {
    const { frames, topic, post, rows, store, restart, client } = await setup("late-scan-exit-grace");
    const skA = "topic:exitgraa";
    const skB = "topic:exitgrbb";
    topic(skA);
    topic(skB);
    void post(skA, { messages: [{ role: "user", content: "go-A" }] });
    await waitFor("A's fat part", () => existsSync(store(skA)) && statSync(store(skA)).size >= FAST * 2080);
    void post(skB, { messages: [{ role: "user", content: "go-B" }] });
    await waitFor("B's first 50 lines", () => existsSync(store(skB)) && (readFileSync(store(skB), "utf8").match(/"text":"\d+,"/g)?.length ?? 0) >= 50);
    const storeB = store(skB);
    restart([skA, skB]);
    const bridge = client();
    await bridge.ensureConnected();
    // B's CLI finishes and exits 150 ms after B's first attach went out, while A's replay still drains.
    const whole = bridge.attachWhole.bind(bridge);
    const calls: string[] = [];
    bridge.attachWhole = (id: string, from: number, attempts?: number) => {
      calls.push(id);
      if (id === skB && calls.filter((c) => c === skB).length === 1) setTimeout(() => writeFileSync(join(tempDir, "exit"), ""), 150);
      return whole(id, from, attempts);
    };
    // The route's windows of `late-scan-route-grace.test.ts`: the grace runs out while B's tail is on its way.
    process.env.TOPICS_STREAM_SOFT_MS = "1000";
    process.env.TOPICS_STREAM_GRACE_MS = "1000";
    const t0 = Date.now();
    void post(skA, { messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
    await waitFor("A's scan on the wire", () => calls.includes(skA), 10_000);
    const drainedB = post(skB, { messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
    try {
      await waitFor("B's adopted row to close", () => rows(skB).every((r) => r.partial === 0), 90_000);
      await drainedB.catch(() => {});
      const answer = rows(skB).filter((r) => r.role === "assistant").pop()?.content ?? "";
      const ends = frames.filter((f) => f.type === "stream:end" && f.sessionKey === skB).map((f) => f.stopCause ?? null);
      console.log(`[late-scan-boot:exit-grace] B closed after ${Date.now() - t0} ms: ${nums(answer).length} numbers, ends ${JSON.stringify(ends)}`);
      expect(readFileSync(storeB, "utf8")).toContain("FINAL-B");
      expect(answer).not.toContain("timed out");
      expect(ends).not.toContain("watchdog");
      expect(nums(answer)).toEqual(Array.from({ length: B_LINES }, (_, i) => i + 1));
    } finally {
      try { bridge.kill(skA); } catch { /* already gone */ }
      try { bridge.kill(skB); } catch { /* already gone */ }
    }
  }, 180_000);
}

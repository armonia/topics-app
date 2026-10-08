/**
 * The scenarios of `late-scan-past-cap.test.ts`, each run in a child `bun test` of its own: the ack caps
 * are read once per process, at import (`server/lib/ai-bridge-client.ts`). The cap is the real one, scaled
 * down; the backlog is a real 20 MB store replayed by the real daemon. Every attach of a re-adoption sits
 * behind that backlog, so each must wait for its late ack. Found by the verifications of PR #268, one case
 * each (`LATE_SCAN_CASE`):
 *  - `open`: the rewind after the scan (phase 2) failed at the cap and closed the open turn with
 *    the failed re-adoption notice, with 2012 numbers out of 10600;
 *  - `completed`: the turn ended while detached, and the rewind of its own replay failed the same way;
 *  - `exit`: the CLI wrote the rest of the turn and exited while the backlog drained, and the fetch of its
 *    tail gave up at the cap: the row closed as a normal answer, cut at 1006 numbers out of 10600.
 */
process.env.TOPICS_AI_BRIDGE_ATTACH_ACK_MS ??= "300";
process.env.TOPICS_AI_BRIDGE_MAX_ACK_MS ??= "300";
process.env.TOPICS_AI_BRIDGE_STALL_TICK_MS ??= "25";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync, writeFileSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tempDir = "";
let dataRoot = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }
const CASE = process.env.LATE_SCAN_CASE ?? "open";
const RESULT = `{"type":"result","result":"FINAL-RESULT","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}`;
const FAST = 10_000;
const SLOW = 600;
const N = FAST + SLOW;

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "late-scan-phase2-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempDir, "ai-bridge.sock"));
  setEnv("TOPICS_STREAM_SOFT_MS", "600000");
  setEnv("TOPICS_STREAM_GRACE_MS", "600000");
  const cli = join(tempDir, "cli.sh");
  // A turn whose first FAST lines are fat (2 KB each, ~20 MB of store), then SLOW more, then the result:
  // still arriving when re-adopted (`open`), all written while detached (`completed`), or written once the
  // re-adoption has started, then the CLI exits (`exit`).
  const rest = {
    open: `while [ $i -le ${N} ]; do printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' $i; sleep 0.02; i=$((i+1)); done
  printf '%s\\n' '${RESULT}'`,
    completed: `sleep 3
  while [ $i -le ${N} ]; do printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' $i; i=$((i+1)); done
  printf '%s\\n' '${RESULT}'`,
    exit: `while [ ! -f ${join(tempDir, "exit")} ]; do sleep 0.01; done
  PAD2=$(head -c 1000 /dev/zero | tr '\\0' 'y')
  while [ $i -le ${N} ]; do printf '{"type":"assistant","pad":"%s","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' "$PAD2" $i; i=$((i+1)); done
  printf '%s\\n' '${RESULT}'
  exit 0`,
  }[CASE];
  if (!rest) throw new Error(`unknown LATE_SCAN_CASE ${CASE}`);
  writeFileSync(cli, `#!/bin/sh
trap 'exit 0' INT
PAD=$(head -c 2000 /dev/zero | tr '\\0' 'x')
while read line; do
  i=1
  while [ $i -le ${FAST} ]; do printf '{"type":"assistant","pad":"%s","message":{"content":[{"type":"text","text":"%d,"}]}}\\n' "$PAD" $i; i=$((i+1)); done
  ${rest}
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

describe(`a re-adoption past the ack cap (${CASE})`, () => {
  test("the turn arrives whole into its own row", async () => {
    const { setupTestDataDir, createTestAppContext, testTmpDir } = await import("./helpers");
    dataRoot = testTmpDir("late-scan-phase2");
    setupTestDataDir(dataRoot);
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const { registerProvider, removeProvider } = await import("../../server/providers");
    const { __resetAiBridgeClientForTests, getAiBridgeClient } = await import("../../server/lib/ai-bridge-client");
    const ctx = await createTestAppContext();
    const frames: Array<{ type?: string; stopCause?: string }> = [];
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => frames.push(m as { type?: string });
    (ctx as { broadcastToTopicSubscribers: (i: string, m: unknown) => void }).broadcastToTopicSubscribers = (_i, m) => frames.push(m as { type?: string });
    const sk = "topic:phase2cap";
    ctx.saveSingleTopic({ id: "phase2ca-0000-0000-0000-000000000000", name: "p2", slug: "p2", parentId: null, links: [], sessionKey: sk, color: "#5865f2",
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

    const provider1 = registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never) as { stop: () => void };
    void post(createTopicsRouter(ctx), { messages: [{ role: "user", content: "go" }] });
    await waitFor("the fat part in the store", () => existsSync(store()) && statSync(store()).size >= FAST * 2080);
    const storePath = store();
    console.log(`[past-cap:${CASE}] store at shutdown: ${statSync(storePath).size} bytes`);
    provider1.stop();
    removeProvider("claude-code");
    __resetAiBridgeClientForTests();
    ctx.activeStreams.delete(sk);
    // Nobody attached: the turn ends in the store alone, and the re-adoption finds it complete.
    if (CASE === "completed") await waitFor("the turn to end while detached", () => readFileSync(storePath, "utf8").includes("FINAL-RESULT"), 30_000);

    registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never);
    const client: any = getAiBridgeClient();
    await client.ensureConnected();
    if (CASE === "exit") {
      // The CLI finishes and exits while the scan's backlog still drains: its last lines and its exit sit on
      // the socket behind the scan's ack, ahead of the rewind's replay (as a 90 s drain would in production).
      const whole = client.attachWhole.bind(client);
      let calls = 0;
      client.attachWhole = (id: string, from: number, attempts?: number) => {
        if (++calls === 1) setTimeout(() => writeFileSync(join(tempDir, "exit"), ""), 50);
        return whole(id, from, attempts);
      };
    }
    const t0 = Date.now();
    const drained = post(createTopicsRouter(ctx), { messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
    try {
      await waitFor("the adopted row to close", () => rows().every((r) => r.partial === 0), 90_000);
      await drained.catch(() => {});
      console.log(`[past-cap:${CASE}] adopted row closed after ${Date.now() - t0} ms`);
      await waitFor("the CLI's result in the store", () => readFileSync(storePath, "utf8").includes("FINAL-RESULT"), 30_000).catch(() => {});
      const assistantRows = rows().filter((r) => r.role === "assistant");
      for (const r of assistantRows) console.log(`[past-cap:${CASE}] assistant row ${r.id}: ${nums(r.content).length} numbers, last ${nums(r.content).slice(-1)[0]}, tail: ${JSON.stringify(r.content.slice(-160))}`);
      expect(readFileSync(storePath, "utf8")).toContain("FINAL-RESULT");
      const answer = assistantRows.pop()?.content ?? "";
      expect(answer).not.toContain("Riadozione del turno non riuscita");
      expect(nums(answer)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    } finally {
      try { client.kill(sk); } catch { /* already gone */ }
    }
  }, 180_000);
});

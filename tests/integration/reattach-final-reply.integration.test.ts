/**
 * A TURN THAT ENDED WHILE THE SERVER WAS AWAY IS WRITTEN WHOLE AT THE NEXT BOOT
 * (card 98ce88d1).
 *
 * 25/09, 17:27:58: topic:7e9caa28 closed its turn (a 1400-character final
 * report) in the same second the server took a SIGTERM. The shutdown detached
 * the broker session, the next boot adopted it ("partial in DB") and the
 * reattach said it added nothing: the row closed with the text the old process
 * had flushed, stopped at "Committing WIP, then building the branch bundle…".
 * The report was only in the broker's store. A store that ends on a `result`
 * was handed to the route as that `result` alone, which carries no text the
 * route reads, and the merge kept the stale row.
 *
 * The real ClaudeCodeProvider and the real ai-bridge daemon drive a fake CLI
 * whose turn ends only once the server has let go of it: during the shutdown
 * (the provider detached, the process still up) and with the server fully
 * gone. Then a fresh provider and fresh routes adopt the session as the boot
 * does (`runHeadlessReattach`'s request).
 *
 * @covers RESUME-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, chmodSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const FIRST_TEXT = "Committing WIP, then building the branch bundle.";
const FINAL_REPORT = "PR aggiornata a `0ea0f9130`: tutti i punti chiusi, commento sulla card fatto.";
let tempDir = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "reattach-final-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempDir, "ai-bridge.sock"));
  const fake = join(tempDir, "fake-claude-final-after-detach.ts");
  cpSync(join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-final-after-detach.ts"), fake);
  chmodSync(fake, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", fake);
});

afterAll(async () => {
  try { const { getProvider } = await import("../../server/providers"); (getProvider("claude-code") as { stop?: () => void } | undefined)?.stop?.(); } catch { /* gone */ }
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  // The daemon this file started, by its own socket path: nothing else has it.
  const found = Bun.spawnSync(["pgrep", "-f", join(tempDir, "ai-bridge.sock")]).stdout.toString().trim();
  for (const pid of found.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ } }
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(50)) if (await check()) return;
  throw new Error(`timed out waiting for ${what}`);
}

/** The turn ends during the shutdown (provider detached, process still up) or with the server fully gone. */
async function turnEndingWithoutServer(when: "shutdown" | "down") {
  const { setupTestDataDir, createTestAppContext, testTmpDir } = await import("./helpers");
  setupTestDataDir(testTmpDir(`reattach-final-${when}`));
  const { createTopicsRouter } = await import("../../server/routes/topics");
  const { registerProvider, removeProvider } = await import("../../server/providers");
  const { __resetAiBridgeClientForTests, getAiBridgeClient } = await import("../../server/lib/ai-bridge-client");
  const finish = join(tempDir, "finish-turn");
  rmSync(finish, { force: true });

  const ctx = await createTestAppContext();
  const frames: Array<{ type?: string }> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => frames.push(m as { type?: string });
  (ctx as { broadcastToTopicSubscribers: (i: string, m: unknown) => void }).broadcastToTopicSubscribers = (_i, m) => frames.push(m as { type?: string });
  const sk = `topic:rf${when.slice(0, 4)}`;
  ctx.saveSingleTopic({ id: `rf${when}-000000000000`, name: when, slug: when, parentId: null, links: [], sessionKey: sk, color: "#5865f2",
    icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, provider: "claude-code" } as never);
  const post = async (router: ReturnType<typeof createTopicsRouter>, body: Record<string, unknown>) => {
    const url = new URL("http://localhost/api/chat");
    const resp = await router(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk, ...body }) }), url, "/api/chat", "POST") as Response;
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    return (async () => { try { while (!(await reader.read()).done) { /* drained */ } } catch { /* cut */ } })();
  };

  // The old server: the turn runs, says its first line and starts a tool.
  const before = registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never) as { stop: () => void };
  void post(createTopicsRouter(ctx), { messages: [{ role: "user", content: "write the report" }] });
  await waitFor("the tool to start", () => frames.some((f) => /tool/.test(f.type ?? "")));
  const rows = () => ctx.db.query("SELECT id, role, content, partial FROM messages WHERE session_key = ? ORDER BY sort_order").all(sk) as Array<{ id: string; role: string; content: string; partial: number }>;
  const turnRow = rows().find((r) => r.role === "assistant")!;
  expect(turnRow.partial).toBe(1);

  // The shutdown detaches the broker session (claude-code `stop()`).
  before.stop();
  if (when === "shutdown") writeFileSync(finish, "");
  // The process goes: its providers, its bridge connection, its streams in memory.
  removeProvider("claude-code");
  __resetAiBridgeClientForTests();
  ctx.activeStreams.delete(sk);
  if (when === "down") writeFileSync(finish, "");
  // The daemon stores the end of the turn: the child has written its `result`.
  const store = join(getAiBridgeClient().storeDir, `${sk.replace(/[^a-zA-Z0-9_-]/g, "_")}.ndjson`);
  await waitFor("the turn's end in the broker store", () => existsSync(store) && readFileSync(store, "utf8").includes(`"result":${JSON.stringify(FINAL_REPORT)}`));
  expect(rows().find((r) => r.id === turnRow.id)?.content ?? "").not.toContain(FINAL_REPORT);

  // The next boot: a fresh provider and fresh routes adopt the session (`runHeadlessReattach`).
  registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never);
  await post(createTopicsRouter(ctx), { messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
  await waitFor("the adopted row to close", () => rows().every((r) => r.partial === 0));
  return rows();
}

describe("a turn that ended while the server was away is written whole at the next boot", () => {
  for (const when of ["shutdown", "down"] as const) {
    test(`ended ${when === "shutdown" ? "during the shutdown" : "with the server fully gone"}: the row has the final report, closed, once`, async () => {
      const rows = await turnEndingWithoutServer(when);
      // The person's message and ONE answer: no second bubble for the adopted turn.
      expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
      const answer = rows[1];
      expect(answer.partial).toBe(0);
      expect(answer.content).toContain(FINAL_REPORT);
      // Nothing twice: the replay rebuilt the row, it did not append to it.
      expect(answer.content.split(FINAL_REPORT).length - 1).toBe(1);
      expect(answer.content.split(FIRST_TEXT).length - 1).toBe(1);
    }, 60_000);
  }
});

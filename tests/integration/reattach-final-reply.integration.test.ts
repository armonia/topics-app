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
  // The fake's "FIXTUREBG" turn replays the recorded CLI session from its working directory.
  cpSync(join(REPO_ROOT, "tests", "fixtures", "claude-cli-2.1.282-background-work.ndjson"), join(tempDir, "background-work.ndjson"));
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

/** An old server, its shutdown and the next boot, on one chat; the store and the rows to look at. */
async function bench(name: string) {
  const { setupTestDataDir, createTestAppContext, testTmpDir } = await import("./helpers");
  setupTestDataDir(testTmpDir(`reattach-final-${name}`));
  const { createTopicsRouter } = await import("../../server/routes/topics");
  const { registerProvider, removeProvider } = await import("../../server/providers");
  const { __resetAiBridgeClientForTests, getAiBridgeClient } = await import("../../server/lib/ai-bridge-client");
  for (const f of ["finish-turn", "got-delayed", "bg-done", "woken-done", "fx-done"]) rmSync(join(tempDir, f), { force: true });
  const ctx = await createTestAppContext();
  const frames: Array<{ type?: string }> = [];
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = (m) => frames.push(m as { type?: string });
  (ctx as { broadcastToTopicSubscribers: (i: string, m: unknown) => void }).broadcastToTopicSubscribers = (_i, m) => frames.push(m as { type?: string });
  const sk = `topic:rf${name.slice(0, 6)}`;
  ctx.saveSingleTopic({ id: `rf${name}-000000000000`, name, slug: name, parentId: null, links: [], sessionKey: sk, color: "#5865f2",
    icon: "MessageSquare", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, provider: "claude-code" } as never);
  const post = async (router: ReturnType<typeof createTopicsRouter>, body: Record<string, unknown>) => {
    const url = new URL("http://localhost/api/chat");
    const resp = await router(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk, ...body }) }), url, "/api/chat", "POST") as Response;
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    return (async () => { try { while (!(await reader.read()).done) { /* drained */ } } catch { /* cut */ } })();
  };
  const provider = registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never) as { stop: () => void };
  const router = createTopicsRouter(ctx);
  return {
    frames, db: ctx.db, sk, post: (body: Record<string, unknown>) => post(router, body),
    rows: () => ctx.db.query("SELECT id, role, content, partial FROM messages WHERE session_key = ? ORDER BY sort_order").all(sk) as Array<{ id: string; role: string; content: string; partial: number }>,
    store: () => join(getAiBridgeClient().storeDir, `${sk.replace(/[^a-zA-Z0-9_-]/g, "_")}.ndjson`),
    /** The shutdown detaches the broker session (claude-code `stop()`), then the process goes. */
    shutdown: (beforeExit?: () => void) => {
      provider.stop();
      beforeExit?.();
      removeProvider("claude-code");
      __resetAiBridgeClientForTests();
      ctx.activeStreams.delete(sk);
    },
    /** The next boot's provider, before anything adopts the session. */
    bootProvider: () => registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never) as unknown as {
      brokerTurnState: (sk: string, o: { park: boolean }) => Promise<string>; backgroundState: (sk: string) => string;
    },
    /** The boot's adoption: fresh routes, `runHeadlessReattach`'s request. */
    reattach: () => post(createTopicsRouter(ctx), { messages: [], mode: "reattach", dispatched: true, provider: "claude-code" }),
    /** The next boot: a fresh provider and fresh routes adopt the session. */
    boot: () => {
      registerProvider({ type: "claude-code", defaultWorkspace: tempDir } as never);
      return post(createTopicsRouter(ctx), { messages: [], mode: "reattach", dispatched: true, provider: "claude-code" });
    },
    /** A daemon older than protocol 3: the store gets no delivery marks. */
    withoutMarks: () => {
      const client = getAiBridgeClient();
      const write = client.write.bind(client);
      client.write = (id: string, data: string) => write(id, data);
    },
  };
}

const has = (file: string, text: string) => existsSync(file) && readFileSync(file, "utf8").includes(text);

const finish = () => writeFileSync(join(tempDir, "finish-turn"), "");

describe("a turn that ended while the server was away is written whole at the next boot", () => {
  for (const when of ["shutdown", "down"] as const) {
    test(`ended ${when === "shutdown" ? "during the shutdown" : "with the server fully gone"}: the row has the final report, closed, once`, async () => {
      const b = await bench(when);
      // The old server: the turn runs, says its first line and starts a tool.
      void b.post({ messages: [{ role: "user", content: "write the report" }] });
      await waitFor("the tool to start", () => b.frames.some((f) => /tool/.test(f.type ?? "")));
      const turnRow = b.rows().find((r) => r.role === "assistant")!;
      expect(turnRow.partial).toBe(1);
      b.shutdown(when === "shutdown" ? finish : undefined);
      if (when === "down") finish();
      await waitFor("the turn's end in the broker store", () => existsSync(b.store()) && readFileSync(b.store(), "utf8").includes(`"result":${JSON.stringify(FINAL_REPORT)}`));
      expect(b.rows().find((r) => r.id === turnRow.id)?.content ?? "").not.toContain(FINAL_REPORT);
      await b.boot();
      await waitFor("the adopted row to close", () => b.rows().every((r) => r.partial === 0));
      const rows = b.rows();
      // The person's message and ONE answer: no second bubble for the adopted turn.
      expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
      expect(rows[1].partial).toBe(0);
      expect(rows[1].content).toContain(FINAL_REPORT);
      // Nothing twice: the replay rebuilt the row, it did not append to it.
      expect(rows[1].content.split(FINAL_REPORT).length - 1).toBe(1);
      expect(rows[1].content.split(FIRST_TEXT).length - 1).toBe(1);
    }, 60_000);
  }

  // Review of #145: a SIGTERM after the message reached stdin but before the
  // CLI's init (its UserPromptSubmit hooks run first) leaves the PREVIOUS turn
  // last in the store. It is not this row's, and its answer must not be copied.
  // The mark the daemon left when it wrote the message says the turn is on its
  // way: the boot waits for it instead of closing the row.
  test("the store's last turn is older than the row: its answer stays out of the new row, and the row gets its own", async () => {
    const b = await bench("older");
    await b.post({ messages: [{ role: "user", content: "OLDTURN" }] });
    await waitFor("the old turn closed", () => b.rows().some((r) => r.role === "assistant" && r.partial === 0 && r.content.includes("OLD-B")));
    void b.post({ messages: [{ role: "user", content: "DELAYED" }] });
    await waitFor("the child to read the message", () => existsSync(join(tempDir, "got-delayed")));
    await waitFor("the new partial row", () => { const r = b.rows(); return r.length === 4 && r[3].partial === 1; });
    b.shutdown();
    void b.boot();
    await Bun.sleep(1000);
    finish();
    await waitFor("the adopted row to close", () => b.rows().every((r) => r.partial === 0), 30_000);
    const newRow = b.rows()[3];
    expect(newRow.content).not.toContain("OLD-A");
    expect(newRow.content).not.toContain("OLD-B");
    expect(newRow.content).toContain("DELAYED-ANSWER.");
  }, 60_000);

  // Review of #145: the first turn after a `/compact` begins at the compaction's
  // EMPTY result; replayed from the last non-empty one, the row closed on it.
  test("the first turn after a /compact, ended during the shutdown: the row gets its final text", async () => {
    const b = await bench("compact");
    await b.post({ messages: [{ role: "user", content: "OLDTURN" }] });
    await b.post({ messages: [{ role: "user", content: "COMPACTNOW" }] });
    void b.post({ messages: [{ role: "user", content: "AFTERCOMPACT" }] });
    await waitFor("its partial row", () => { const r = b.rows(); return r.at(-1)?.partial === 1 && r.some((x) => x.content === "AFTERCOMPACT"); });
    b.shutdown(finish);
    await waitFor("its end in the broker store", () => readFileSync(b.store(), "utf8").includes('"result":"AC-FINAL report."'));
    await b.boot();
    await waitFor("the adopted row to close", () => b.rows().every((r) => r.partial === 0), 30_000);
    const last = b.rows().at(-1)!;
    expect(last.content).toContain("AC-FINAL report.");
    expect(last.content).not.toContain("OLD-B");
  }, 60_000);

  // Second review of #145, W: 87 of 1724 closed turns (5%) in 30 days had a
  // woken turn within 20 s of their end. The woken turn's text is not the
  // person's answer, with or without the marks.
  for (const marks of [true, false]) {
    test(`the row's turn ends, then its background command wakes the CLI, all while the server is away${marks ? "" : ": a daemon without marks, as on main"}`, async () => {
      const b = await bench(marks ? "woken" : "wokenold");
      if (!marks) b.withoutMarks();
      void b.post({ messages: [{ role: "user", content: "BGREPORT" }] });
      await waitFor("the background command in the store", () => has(b.store(), "toolu_t1"));
      await waitFor("the tool to start", () => b.frames.some((f) => /tool/.test(f.type ?? "")));
      b.shutdown(finish);
      await waitFor("the turn's result", () => has(b.store(), '"result":"T1-FINAL'));
      writeFileSync(join(tempDir, "bg-done"), "");
      await waitFor("the woken turn's result", () => existsSync(join(tempDir, "woken-done")) && has(b.store(), '"result":"W2'));
      const provider = b.bootProvider();
      await b.reattach();
      await waitFor("the adopted row to close", () => b.rows().every((r) => r.partial === 0), 30_000);
      const row = b.rows().find((r) => r.role === "assistant")!;
      expect(row.content).not.toContain("W2");
      if (marks) expect(row.content).toContain("T1-FINAL: the PR is pushed, CI is running.");
      // The command reported and the wake answered it: nothing is left running.
      expect(provider.backgroundState(b.sk)).toBe("none");
    }, 60_000);
  }

  // H: the recorded CLI 2.1.282 session, whose background Agent keeps printing after the turn's result.
  test("the row's turn ends during the shutdown while its background Agent keeps printing: the row gets its final text", async () => {
    const b = await bench("bgagent");
    void b.post({ messages: [{ role: "user", content: "FIXTUREBG" }] });
    await waitFor("the recorded tools in the store", () => has(b.store(), '"name":"Monitor"'));
    await Bun.sleep(1000);
    b.shutdown(finish);
    await waitFor("the recorded turn's end", () => existsSync(join(tempDir, "fx-done")));
    await b.boot();
    await waitFor("the adopted row to close", () => b.rows().every((r) => r.partial === 0), 30_000);
    expect(b.rows().find((r) => r.role === "assistant")!.content).toContain("Launched.");
  }, 60_000);

  // P: a row closed from outside while the child lived goes through the boot's
  // probe, which parks its scan; the turn ends before the adoption claims it.
  test("the turn ends between the boot's probe and the adoption: the row gets its final text", async () => {
    const b = await bench("parked");
    void b.post({ messages: [{ role: "user", content: "write the report" }] });
    await waitFor("the tool to start", () => b.frames.some((f) => /tool/.test(f.type ?? "")));
    b.shutdown();
    const row = b.rows().find((r) => r.role === "assistant")!;
    b.db.run("UPDATE messages SET partial = 0 WHERE id = ?", [row.id]);
    expect(await b.bootProvider().brokerTurnState(b.sk, { park: true })).toBe("open");
    finish();
    await waitFor("the turn's end in the broker store", () => has(b.store(), `"result":${JSON.stringify(FINAL_REPORT)}`));
    await Bun.sleep(300);
    await b.reattach();
    await waitFor("the adopted row to close", () => b.rows().every((r) => r.partial === 0), 30_000);
    expect(b.rows().find((r) => r.id === row.id)!.content).toContain(FINAL_REPORT);
  }, 60_000);
});

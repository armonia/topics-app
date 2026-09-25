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
  // Short broker windows for the mute daemon below (production: 15 s, 1 s), read when the client loads.
  setEnv("TOPICS_AI_BRIDGE_ATTACH_ACK_MS", "3000");
  setEnv("TOPICS_AI_BRIDGE_STALL_TICK_MS", "250");
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
  for (const f of ["finish-turn", "got-delayed", "bg-done", "woken-done", "fx-done", "lt-done", "w1-finish", "bg2-done", "w2-finish", "tail-mb"]) rmSync(join(tempDir, f), { force: true });
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
const touch = (name: string) => writeFileSync(join(tempDir, name), "");

/** Wakes adopted the way server.ts does: through the route, `mode: "woken"`. Returns the undo. */
async function adoptWakes(post: (body: Record<string, unknown>) => Promise<unknown>): Promise<() => void> {
  const { ClaudeCodeProvider } = await import("../../server/providers/claude-code");
  const slot = ClaudeCodeProvider as unknown as { onWokenTurn: unknown };
  const before = slot.onWokenTurn;
  ClaudeCodeProvider.observeWokenTurns(() => { void post({ messages: [], mode: "woken", provider: "claude-code" }); });
  return () => { slot.onWokenTurn = before; };
}

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

  // Third review of #145: the replayed row closes on its own result while the
  // reattach still waits for the attach's ack, and the chat's queue sends the
  // next message at once. The store's last result was handed to that next
  // row's handler, which closed it as «no reply» and lost its answer.
  test("the row is a slow /compact that ends during the shutdown: the next message still gets its answer", async () => {
    const b = await bench("slowcomp");
    await b.post({ messages: [{ role: "user", content: "OLDTURN" }] });
    void b.post({ messages: [{ role: "user", content: "SLOWCOMPACT" }] });
    await waitFor("its partial row", () => { const r = b.rows(); return r.at(-1)?.partial === 1 && r.some((x) => x.content === "SLOWCOMPACT"); });
    await Bun.sleep(300);
    b.shutdown(finish);
    await waitFor("its end in the broker store", () => (readFileSync(b.store(), "utf8").match(/"type":"result"/g) ?? []).length >= 2 && has(b.store(), "compact_boundary"));
    await b.boot();
    await waitFor("the adopted row to close", () => b.rows().every((r) => r.partial === 0), 30_000);
    expect(b.rows().at(-1)!.content).not.toContain("OLD-B");
    await b.post({ messages: [{ role: "user", content: "OLDTURN" }] });
    await waitFor("the next answer", () => { const r = b.rows().at(-1)!; return r.role === "assistant" && r.partial === 0 && r.content.includes("OLD-B"); }, 20_000);
  }, 60_000);

  test("the next message sent the moment the replayed row closes gets its own answer", async () => {
    const b = await bench("nextfast");
    void b.post({ messages: [{ role: "user", content: "write the report" }] });
    await waitFor("the tool to start", () => b.frames.some((f) => /tool/.test(f.type ?? "")));
    b.shutdown(finish);
    await waitFor("the turn's end in the broker store", () => has(b.store(), `"result":${JSON.stringify(FINAL_REPORT)}`));
    b.bootProvider();
    const adopted = b.reattach();
    // The chat's queue sends as soon as the row closes.
    for (const end = Date.now() + 30_000; Date.now() < end && !b.rows().every((r) => r.partial === 0); await Bun.sleep(2)) { /* polling */ }
    await b.post({ messages: [{ role: "user", content: "hello there" }] });
    await adopted;
    await waitFor("the next answer", () => { const r = b.rows().at(-1)!; return r.role === "assistant" && r.partial === 0; }, 20_000);
    await Bun.sleep(500);
    expect(b.rows().at(-1)!.content).toBe("ok");
    expect(b.rows()[1].content).toContain(FINAL_REPORT);
  }, 60_000);

  // The same window, wide: 3 MB after the row's result reach the server over
  // several reads, and the next message registers its handler in between. The
  // tail (an Agent's lines, then a wake) is nobody's, least of all that row's.
  test("the next message sent while the replay still delivers the store's tail gets its own answer, not the tail", async () => {
    const b = await bench("longtail");
    void b.post({ messages: [{ role: "user", content: "LONGTAIL" }] });
    await waitFor("the tool to start", () => b.frames.some((f) => /tool/.test(f.type ?? "")));
    b.shutdown(finish);
    await waitFor("the store's tail", () => existsSync(join(tempDir, "lt-done")) && has(b.store(), '"result":"LT-WAKE.'));
    b.bootProvider();
    const adopted = b.reattach();
    for (const end = Date.now() + 30_000; Date.now() < end && !b.rows().every((r) => r.partial === 0); await Bun.sleep(2)) { /* polling */ }
    await b.post({ messages: [{ role: "user", content: "hello there" }] });
    await adopted;
    await waitFor("the next answer", () => { const r = b.rows().at(-1)!; return r.role === "assistant" && r.partial === 0; }, 20_000);
    await Bun.sleep(500);
    const rows = b.rows();
    expect(rows[1].content).toContain("LT-FINAL report.");
    expect(rows.at(-1)!.content).not.toContain("LT-WAKE");
    expect(rows.at(-1)!.content).toBe("ok");
  }, 60_000);

  // A wake starts with no stdin write, so no delivery mark: its adopter marks
  // it. Before that, a wake in flight at the shutdown whose second wake opened
  // before the boot got that second wake's text, as on main.
  test("two wakes across a restart: the first wake's row keeps its own turn", async () => {
    const b = await bench("wakes2");
    const undo = await adoptWakes(b.post);
    try {
      await b.post({ messages: [{ role: "user", content: "BGWAKES" }] });
      touch("bg-done");
      await waitFor("the first wake's tool", () => b.frames.some((f) => /tool/.test(f.type ?? "")));
      await Bun.sleep(1000);
      const wakeRow = b.rows().at(-1)!;
      expect(wakeRow.role).toBe("assistant");
      b.shutdown();
      touch("w1-finish");
      await waitFor("the first wake's result", () => has(b.store(), '"result":"W1-FINAL'));
      touch("bg2-done");
      await waitFor("the second wake's text", () => has(b.store(), "W2-TEXT"));
      await Bun.sleep(300);
      void b.boot();
      await waitFor("the first wake's row to close", () => b.rows().find((r) => r.id === wakeRow.id)?.partial === 0, 5_000).catch(() => {});
      touch("w2-finish");
      await waitFor("every row closed", () => b.rows().every((r) => r.partial === 0), 30_000);
      const row = b.rows().find((r) => r.id === wakeRow.id)!;
      expect(row.content).not.toContain("W2-TEXT");
      expect(row.content).toContain("W1-FINAL: all green.");
    } finally { undo(); }
  }, 60_000);

  test("a wake that ended while the server was away fills its row, instead of «no reply»", async () => {
    const b = await bench("wakedown");
    const undo = await adoptWakes(b.post);
    try {
      await b.post({ messages: [{ role: "user", content: "BGWAKES" }] });
      touch("bg-done");
      await waitFor("the wake's tool", () => b.frames.some((f) => /tool/.test(f.type ?? "")));
      await Bun.sleep(1000);
      const wakeRow = b.rows().at(-1)!;
      b.shutdown();
      touch("w1-finish");
      await waitFor("the wake's result", () => has(b.store(), '"result":"W1-FINAL'));
      await b.boot();
      await waitFor("every row closed", () => b.rows().every((r) => r.partial === 0), 30_000);
      const row = b.rows().find((r) => r.id === wakeRow.id)!;
      expect(row.content).toContain("W1-FINAL: all green.");
      expect(row.content).not.toContain("Nessuna risposta");
    } finally { undo(); }
  }, 60_000);

  // Review of #145, round 4 (H3): the daemon goes mute (SIGSTOP) while the next
  // send waits behind the replay. The wait must end, and the send visibly.
  test("the daemon goes mute while a send waits behind the replay: the wait ends, and the send ends visibly", async () => {
    const b = await bench("h3mute");
    writeFileSync(join(tempDir, "tail-mb"), "20");
    void b.post({ messages: [{ role: "user", content: "LONGTAIL" }] });
    await waitFor("the tool to start", () => b.frames.some((f) => /tool/.test(f.type ?? "")));
    b.shutdown(finish);
    await waitFor("the store's tail", () => existsSync(join(tempDir, "lt-done")) && has(b.store(), '"result":"LT-WAKE.'), 60_000);
    b.bootProvider();
    const { getAiBridgeClient } = await import("../../server/lib/ai-bridge-client");
    const client = getAiBridgeClient() as unknown as { attach: (id: string, from: number) => Promise<unknown> };
    const attach = client.attach.bind(client);
    let replayDone = 0;
    client.attach = async (id: string, from: number) => { try { return await attach(id, from); } finally { if (from > 0 && !replayDone) replayDone = Date.now(); } };
    const adopted = b.reattach();
    for (const end = Date.now() + 60_000; Date.now() < end && !b.rows().every((r) => r.partial === 0); await Bun.sleep(2)) { /* polling */ }
    void b.post({ messages: [{ role: "user", content: "hello there" }] });
    const daemons = Bun.spawnSync(["pgrep", "-f", join(tempDir, "ai-bridge.sock")]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
    const heldWhenStopped = replayDone === 0;
    for (const pid of daemons) { try { process.kill(pid, "SIGSTOP"); } catch { /* gone */ } }
    try {
      await waitFor("the replay's wait to end with the daemon stopped", () => replayDone !== 0, 60_000);
    } finally {
      for (const pid of daemons) { try { process.kill(pid, "SIGCONT"); } catch { /* gone */ } }
    }
    await waitFor("the held send's row to close", () => { const r = b.rows().at(-1)!; return r.role === "assistant" && r.partial === 0; }, 90_000);
    await Promise.race([adopted, Bun.sleep(5_000)]);
    const rows = b.rows();
    expect(heldWhenStopped).toBe(true);
    expect(rows.at(-1)!.content.length).toBeGreaterThan(0);
    expect(rows.at(-1)!.content).not.toContain("LT-WAKE");
    expect(rows[1].content).toContain("LT-FINAL report.");
    expect(rows[1].content).not.toContain("Riadozione");
  }, 240_000);
});

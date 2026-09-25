/**
 * A CHILD KILLED MID-TURN RELEASES ITS SEND AT ONCE, AND A SEND STOPPED WHILE
 * QUEUED NEVER REACHES THE CLI.
 *
 * Chat 3019832f, 2026-09-24. The lifetime cap killed the CLI in the middle of a
 * turn at 12:42. In broker mode `kill` drops the handlers for the key, so the
 * exit reached nobody: the send stayed pending until the 30 minute watchdog at
 * 13:12, and the per-session queue with it. Meanwhile the route closed five
 * more messages as «Response timed out», and when the queue finally moved they
 * ran anyway, on handlers that were already closed.
 *
 * The lifetime cap no longer kills a turn in flight (see
 * `claude-code-ask-clocks.test.ts`), so the kill here comes from `/clear`
 * (`resetSession`), the other real caller that kills a live turn on purpose.
 * Real broker, real (fake) CLI: `tests/e2e/helpers/fake-claude-sigint-exit.ts`
 * starts a turn that never ends on its own when the message says "work".
 * @covers CCLI-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, chmodSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { slackMs } from "../../tests/helpers/time-slack";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
let sock = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  // The ai-bridge client is a process-wide singleton bound to the socket it
  // first saw: drop whatever an earlier file left behind.
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "kill-releases-send-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  // Its own daemon socket inside the temp dir, never one shared with another
  // file (see claude-code-abort-send.integration.test.ts for the CI run that
  // taught this).
  sock = join(tempDir, "ai-bridge.sock");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", sock);
  const src = join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-sigint-exit.ts");
  const fake = join(tempDir, "fake-claude-sigint-exit.ts");
  cpSync(src, fake);
  chmodSync(fake, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", fake);

  const { initDatabase, getDatabase } = await import("../db");
  initDatabase(REPO_ROOT);
  const now = new Date().toISOString();
  const insert = getDatabase().prepare(
    `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run("t-krs-a", "krs-a", "krs-a", "topic:kill-releases-send", now, now);
  insert.run("t-krs-a2", "krs-a2", "krs-a2", "topic:kill-releases-send-cap", now, now);
  insert.run("t-krs-f", "krs-f", "krs-f", "topic:stop-drops-queued", now, now);
  insert.run("t-krs-h", "krs-h", "krs-h", "topic:dead-between-turns", now, now);
  insert.run("t-krs-i", "krs-i", "krs-i", "topic:watchdog-after-hold", now, now);
  insert.run("t-krs-j", "krs-j", "krs-j", "topic:watchdog-control", now, now);
  insert.run("t-krs-g", "krs-g", "krs-g", "topic:stop-before-ready", now, now);
  insert.run("t-krs-b", "krs-b", "krs-b", "topic:queued-send-stopped", now, now);
  insert.run("t-krs-c", "krs-c", "krs-c", "topic:reattach-killed-clear", now, now);
  insert.run("t-krs-d", "krs-d", "krs-d", "topic:reattach-killed-stop", now, now);
});

afterAll(async () => {
  // Dispose the client FIRST, so killing the daemon does not trigger a
  // reconnect that respawns it.
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* never opened */ }
  try {
    const pidPath = sock.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch { /* already gone */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

/** A stream handler that records every callback, tagged, with its time. */
function recorder(tag: string, log: { at: number; ev: string }[]) {
  const push = (ev: string) => log.push({ at: Date.now(), ev: `${tag}:${ev}` });
  return {
    onTextDelta: () => push("delta"),
    onToolStart: () => push("tool"),
    onToolResult: () => push("tool-result"),
    onSubAgentUpdate: () => push("subagent"),
    onUserInputRequired: () => push("input"),
    onAborted: (m?: { turnEnd?: { cause?: string } }) => push(m?.turnEnd?.cause ? `aborted:${m.turnEnd.cause}` : "aborted"),
    onCompaction: () => push("compaction"),
    onDone: (m?: { result?: string }) => push(`done:${m?.result ?? ""}`),
    onError: (e: string) => push(`error:${e}`),
  };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) return false;
    await sleep(10);
  }
  return true;
}

/** Every stdin write for one session, whichever child it goes to. */
async function spyWrites(sk: string) {
  const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
  const client = getAiBridgeClient() as any;
  const writes: string[] = [];
  const realWrite = client.write.bind(client);
  client.write = (id: string, data: string) => {
    if (id === sk) writes.push(data);
    return realWrite(id, data);
  };
  return { client, writes, restore: () => { client.write = realWrite; } };
}

describe("a killed child and the session queue (real broker, real child)", () => {
  /**
   * Two ways a child dies under a live send. `/clear` is the person throwing
   * the turn away: it ends as a cancel by the user, like Stop, with no error
   * and no error push. A kill by the machine ends as a watchdog stop, the cause
   * the route's own watchdog writes, which the resume reads as "the agent
   * stopped answering". After the guards, the one machine kill that still
   * lands on a turn in flight is the lifetime cap on a turn silent past the
   * watchdog window: here at test scale. What happens to the send queued
   * behind differs too: after a machine kill it runs at once on a fresh child;
   * `/clear` deleted the row it would answer, so it is dropped, with its
   * stream told why (the route's /clear closes no stream) and nothing written.
   */
  const KILLS = [
    {
      name: "/clear",
      sk: "topic:kill-releases-send",
      kill: async (provider: any, sk: string) => { await provider.resetSession(sk); },
      ending: (ev: string) => ev === "A:aborted:user",
      queued: "dropped" as const,
    },
    {
      name: "the lifetime cap on a silent turn",
      sk: "topic:kill-releases-send-cap",
      kill: async (provider: any, sk: string) => {
        const pp = provider.processes.get(sk);
        pp.lifetimeTimer?.clear();
        pp.lifetimeTimer = provider.armLifetime(pp, sk, { ms: 20, rearmMs: 10, wedgedMs: 100 });
        await waitFor(() => !pp.alive, slackMs(5_000));
      },
      ending: (ev: string) => ev === "A:aborted:watchdog",
      queued: "runs" as const,
    },
  ];
  for (const k of KILLS) {
    test(`a kill by ${k.name} settles the send at once, and the queued send ${k.queued === "runs" ? "starts" : "is dropped"}`, async () => {
      const sk = k.sk;
      const { ClaudeCodeProvider } = await import("./claude-code");
      const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
      const p = provider as any;
      const log: { at: number; ev: string }[] = [];
      const spy = await spyWrites(sk);

      // A: a turn that works until something stops it.
      const sendA = provider.sendChat(sk, "do some work", recorder("A", log) as never);
      expect(await waitFor(() => log.some((l) => l.ev === "A:tool"), slackMs(10_000))).toBe(true);
      const ppA = p.processes.get(sk);
      expect(ppA.pendingReject).not.toBeNull();

      // B: queued behind A on the per-session queue.
      const sendB = provider.sendChat(sk, "tutto ok?", recorder("B", log) as never);
      await sleep(50);
      expect(log.some((l) => l.ev.startsWith("B:"))).toBe(false);

      // Kill A's child mid-turn.
      await k.kill(provider, sk);
      const killedAt = Date.now();

      expect(ppA.pendingReject).toBeNull();
      expect(await waitFor(() => log.some((l) => k.ending(l.ev)), slackMs(100))).toBe(true);
      expect(log.find((l) => k.ending(l.ev))!.at - killedAt).toBeLessThan(slackMs(100));
      // One ending, not two.
      expect(log.filter((l) => /^A:(aborted|error|done)/.test(l.ev))).toHaveLength(1);
      await sendA;

      if (k.queued === "runs") {
        // B does not wait for a 30 minute watchdog: it gets a fresh child and
        // its own answer.
        expect(await waitFor(() => log.some((l) => l.ev.startsWith("B:done")), slackMs(10_000))).toBe(true);
        await sendB;
        const bEvents = log.filter((l) => l.ev.startsWith("B:") && l.ev !== "B:delta").map((l) => l.ev);
        expect(bEvents).toEqual(["B:done:ricevuto: tutto ok?"]);
      } else {
        expect(await sendB).toEqual({ runId: undefined, notSent: true });
        expect(log.filter((l) => l.ev.startsWith("B:")).map((l) => l.ev)).toEqual(["B:aborted:user"]);
        expect(spy.writes.some((w) => w.includes("do some work"))).toBe(true);
        expect(spy.writes.some((w) => w.includes("tutto ok?"))).toBe(false);
      }

      spy.restore();
      provider.stop();
    }, 30_000);
  }

  test("a send stopped while queued is never written to the CLI and never calls its handler", async () => {
    const sk = "topic:queued-send-stopped";
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    const log: { at: number; ev: string }[] = [];

    // Every stdin write for this session, whichever child it goes to.
    const client = getAiBridgeClient() as any;
    const writes: string[] = [];
    const realWrite = client.write.bind(client);
    client.write = (id: string, data: string) => {
      if (id === sk) writes.push(data);
      return realWrite(id, data);
    };

    try {
      const sendA = provider.sendChat(sk, "do some work", recorder("A", log) as never);
      expect(await waitFor(() => log.some((l) => l.ev === "A:tool"), slackMs(10_000))).toBe(true);

      const sendB = provider.sendChat(sk, "tutto ok?", recorder("B", log) as never);
      await sleep(50);

      // The route's watchdog gives up on B while it is still queued behind A,
      // closes B's stream itself, and aborts the session.
      await provider.abort(sk, undefined, "watchdog");

      await sendA;
      // Nothing reached the model: the route rolls back what it marked as sent.
      // `sendChat` settles only when its turn is over, so a B wrongly released
      // would already have written and answered by now: no wait is needed.
      expect(await sendB).toEqual({ runId: undefined, notSent: true });

      // The spy does see this session's writes (A's), so its silence on B means something.
      expect(writes.some((w) => w.includes("do some work"))).toBe(true);
      expect(writes.some((w) => w.includes("tutto ok?"))).toBe(false);
      expect(log.filter((l) => l.ev.startsWith("B:"))).toEqual([]);
    } finally {
      client.write = realWrite;
      provider.stop();
    }
  }, 30_000);

  /**
   * A re-adoption after a restart parks its turn on a promise that nobody
   * awaits until the second broker attach returns. A kill (`/clear`) or a Stop
   * landing in that window rejected it with no listener, and an unhandled
   * rejection makes Bun exit: the whole server went down with every stream on
   * it. Found by adversarial review of the kill rejection; the Stop variant was
   * already there on origin/main.
   */
  for (const trigger of ["clear", "stop"] as const) {
    test(`a ${trigger} during a re-adoption does not leave an unhandled rejection`, async () => {
      const sk = `topic:reattach-killed-${trigger}`;
      const { ClaudeCodeProvider } = await import("./claude-code");
      const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
      const unhandled: string[] = [];
      const onUnhandled = (e: unknown) => { unhandled.push(String((e as Error)?.message ?? e)); };
      process.on("unhandledRejection", onUnhandled);
      const log: { at: number; ev: string }[] = [];

      // A turn in flight, then a "restart": the old provider detaches and the
      // child keeps working in the daemon.
      const before = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
      void before.sendChat(sk, "do some work", recorder("A", log) as never);
      expect(await waitFor(() => log.some((l) => l.ev === "A:tool"), slackMs(10_000))).toBe(true);
      before.stop();

      const after = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
      const client = getAiBridgeClient() as any;
      const realAttach = client.attach.bind(client);
      let attaches = 0;
      client.attach = async (id: string, from: number) => {
        if (id === sk && ++attaches === 2) {
          // The second attach is phase 2: the turn's promise is already armed.
          setTimeout(() => {
            if (trigger === "clear") void after.resetSession(sk);
            else void after.abort(sk, undefined, "user");
          }, 0);
          await sleep(50);
        }
        return realAttach(id, from);
      };
      try {
        await after.reattach(sk, recorder("R", log) as never);
        await sleep(200);
        expect(attaches).toBeGreaterThanOrEqual(2);
        expect(unhandled).toEqual([]);
      } finally {
        client.attach = realAttach;
        process.off("unhandledRejection", onUnhandled);
        after.stop();
      }
    }, 30_000);
  }

  test("stop() tells the sends queued in the provider that the server is going away", async () => {
    // A queued send's stream is still open, and the provider is going away
    // under it. Direct mode used to spawn a new child for it after the stop.
    const sk = "topic:stop-drops-queued";
    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    const log: { at: number; ev: string }[] = [];
    void provider.sendChat(sk, "do some work", recorder("A", log) as never);
    expect(await waitFor(() => log.some((l) => l.ev === "A:tool"), slackMs(10_000))).toBe(true);
    void provider.sendChat(sk, "tutto ok?", recorder("B", log) as never);
    await sleep(50);

    provider.stop();

    expect(log.filter((l) => l.ev.startsWith("B:")).map((l) => l.ev)).toEqual(["B:aborted:server-shutdown"]);
  }, 30_000);

  test("a Stop before the fresh child is ready: nothing is written, and the queue moves", async () => {
    // Between the spawn and its ack no send is waiting yet, so `abort()` finds
    // nothing to reject, and a SIGINT sent before the spawn reaches nobody.
    // The message then went to a child whose every line is dropped as a
    // stopped child's tail: the send hung until the 30 minute watchdog, and
    // the queue with it (adversarial review, PR #134; also on origin/main).
    const sk = "topic:stop-before-ready";
    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    const p = provider as any;
    const log: { at: number; ev: string }[] = [];
    const spy = await spyWrites(sk);
    const realSpawn = spy.client.spawn.bind(spy.client);
    spy.client.spawn = async (id: string, opts: unknown) => {
      if (id === sk) await sleep(300);
      return realSpawn(id, opts);
    };
    try {
      const handlerA = recorder("A", log);
      const sendA = provider.sendChat(sk, "stoppami", handlerA as never);
      expect(await waitFor(() => p.processes.get(sk)?.streamHandler === handlerA, slackMs(5_000))).toBe(true);

      await provider.abort(sk, undefined, "user");

      const settled = await Promise.race([sendA, sleep(slackMs(2_000)).then(() => "still pending")]);
      expect(settled).toEqual({ runId: undefined, notSent: true });
      expect(spy.writes.some((w) => w.includes("stoppami"))).toBe(false);
      expect(log.filter((l) => l.ev.startsWith("A:")).map((l) => l.ev)).toEqual(["A:aborted:user"]);

      // The next message is not stuck behind it.
      void provider.sendChat(sk, "tutto ok?", recorder("B", log) as never);
      expect(await waitFor(() => log.some((l) => l.ev.startsWith("B:done")), slackMs(15_000))).toBe(true);
    } finally {
      spy.client.spawn = realSpawn;
      spy.restore();
      provider.stop();
    }
  }, 45_000);

  test("a child dead between turns: the next send, registered first as the route does, gets its answer", async () => {
    // The child exits on its own between two turns and stays in the map, dead.
    // The route registers the next send's handler BEFORE sendChat, and it
    // landed on that dead pp; the spawn of a fresh child then cleans the dead
    // one up with a kill, which ended that handler as a watchdog stop. The
    // message still reached the CLI and was answered, into a closed turn: with
    // the resume of PR #135 on top, the same message went out again and again
    // (PR #134 review, round 2; red on fe5d829d0 only).
    const sk = "topic:dead-between-turns";
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    const p = provider as any;
    const log: { at: number; ev: string }[] = [];
    try {
      await provider.sendChat(sk, "ciao", recorder("A", log) as never);
      expect(log.some((l) => l.ev.startsWith("A:done"))).toBe(true);
      const ppA = p.processes.get(sk);
      getAiBridgeClient().signal(sk, "SIGINT");
      expect(await waitFor(() => !ppA.alive, slackMs(5_000))).toBe(true);
      expect(p.processes.get(sk)).toBe(ppA);

      const hB = recorder("B", log);
      provider.registerStreamHandler(sk, undefined, hB as never);
      await provider.sendChat(sk, "tutto ok?", hB as never);

      const bEvents = log.filter((l) => l.ev.startsWith("B:") && l.ev !== "B:delta").map((l) => l.ev);
      expect(bEvents).toEqual(["B:done:ricevuto: tutto ok?"]);
    } finally {
      provider.stop();
    }
  }, 30_000);

  test("control: a turn silent past the send watchdog's window, with nobody waiting, is ended", async () => {
    // Proves the shrunk window really bites, so the test below cannot pass
    // just because the watchdog never ran.
    const sk = "topic:watchdog-control";
    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    (provider as any).turnWatchdogMs = 1_000;
    const log: { at: number; ev: string }[] = [];
    try {
      void provider.sendChat(sk, "do some work", recorder("A", log) as never);
      expect(await waitFor(() => log.some((l) => l.ev.startsWith("A:error:Nessuna attività")), slackMs(5_000))).toBe(true);
    } finally {
      provider.stop();
    }
  }, 30_000);

  test("the send watchdog does not count a permission wait as silence", async () => {
    // A permission prompt stops the CLI's output, and so does the command it
    // approves. The watchdog re-armed while the prompt was open, but then
    // measured silence from the tool_use that asked: its first check after
    // the answer killed the approved command while it ran, with the "no model
    // activity for 30 minutes" notice (a 5 minute build: about one time in six).
    // Scale: a 2 s window, a 3 s wait, a check 1.5 s after the answer.
    const sk = "topic:watchdog-after-hold";
    const { ClaudeCodeProvider } = await import("./claude-code");
    const { beginPermission, endPermission } = await import("../lib/permission-bridge");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
    (provider as any).turnWatchdogMs = 2_000;
    const log: { at: number; ev: string }[] = [];
    try {
      const sentAt = Date.now();
      void provider.sendChat(sk, "do some work", recorder("A", log) as never);
      expect(await waitFor(() => log.some((l) => l.ev === "A:tool"), slackMs(5_000))).toBe(true);
      beginPermission(sk, "toolu_long");

      await sleep(Math.max(0, sentAt + 3_000 - Date.now()));
      endPermission(sk, "toolu_long");
      // The approved command runs, printing nothing.
      await sleep(1_500);

      expect(log.filter((l) => /^A:(error|aborted|done)/.test(l.ev))).toEqual([]);
    } finally {
      await provider.abort(sk, undefined, "user");
      provider.stop();
    }
  }, 30_000);
});

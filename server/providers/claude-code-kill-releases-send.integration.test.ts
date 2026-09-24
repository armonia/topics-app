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
  insert.run("t-krs-a2", "krs-a2", "krs-a2", "topic:kill-releases-send-config", now, now);
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
    onAborted: () => push("aborted"),
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

describe("a killed child and the session queue (real broker, real child)", () => {
  /**
   * Two ways a child dies under a live send. `/clear` is the person throwing
   * the turn away: it ends as a cancel, like Stop, with no error and no error
   * push. Any other kill is an error that says who did it; here a config change
   * on a turn the route stopped watching (handler released, send still
   * pending), the one system kill that can still land on a turn in flight.
   */
  const KILLS = [
    {
      name: "/clear",
      sk: "topic:kill-releases-send",
      kill: async (provider: any, sk: string) => { await provider.resetSession(sk); },
      ending: (ev: string) => ev === "A:aborted",
    },
    {
      name: "a config change",
      sk: "topic:kill-releases-send-config",
      kill: async (provider: any, sk: string) => {
        provider.unregisterStreamHandler(sk);
        provider.refreshSessionConfig(sk);
      },
      ending: (ev: string) => ev.startsWith("A:error:") && ev.includes("configuration change"),
    },
  ];
  for (const k of KILLS) {
    test(`a kill by ${k.name} settles the send at once, and the queued send starts`, async () => {
      const sk = k.sk;
      const { ClaudeCodeProvider } = await import("./claude-code");
      const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });
      const p = provider as any;
      const log: { at: number; ev: string }[] = [];

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
      const killedAt = Date.now();
      await k.kill(provider, sk);

      expect(ppA.pendingReject).toBeNull();
      expect(await waitFor(() => log.some((l) => k.ending(l.ev)), slackMs(100))).toBe(true);
      expect(log.find((l) => k.ending(l.ev))!.at - killedAt).toBeLessThan(slackMs(100));
      // One ending, not two.
      expect(log.filter((l) => /^A:(aborted|error|done)/.test(l.ev))).toHaveLength(1);
      await sendA;

      // B does not wait for a 30 minute watchdog: it gets a fresh child and its
      // own answer.
      expect(await waitFor(() => log.some((l) => l.ev.startsWith("B:done")), slackMs(10_000))).toBe(true);
      await sendB;
      const bEvents = log.filter((l) => l.ev.startsWith("B:") && l.ev !== "B:delta").map((l) => l.ev);
      expect(bEvents).toEqual(["B:done:ricevuto: tutto ok?"]);

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
      expect(await sendB).toEqual({ runId: undefined, notSent: true });
      // Give a wrongly released B the time to spawn a child and answer.
      await sleep(slackMs(1500));

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
});

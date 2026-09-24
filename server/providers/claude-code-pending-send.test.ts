/**
 * `hasPendingSend`: is a send for this session in flight or waiting in the
 * per-session serial queue?
 *
 * The question the resume sweep failed to ask on 24/09 (topic 3019832f). The
 * watchdog had closed the turn and the process was dead, so every liveness
 * probe answered "nothing running", while the original send was still parked
 * on `await prev` in `sendChat`. The sweep resent the message four times, and
 * each resend queued one more turn behind the stuck one. Process liveness
 * cannot see a waiting send; the queue tail can.
 *
 * @covers RESUME-01
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeCodeProvider } from "./claude-code";
import { initDatabase, closeDatabase } from "../db";
// Namespace import: the file must load, and fail on the assertion, where the
// registry lacks the function.
import * as registry from "./index";
const { getProvider, listProviders, registerProvider, removeProvider } = registry;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Enough turns of the event loop for any chain of `then` to settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("ClaudeCodeProvider.hasPendingSend", () => {
  test("a session the queue has never seen has nothing pending", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    expect(await provider.hasPendingSend("topic:never-seen")).toBe(false);
  });

  test("a queue tail that never settles is a pending send", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    (provider as any).queues.set("topic:x", new Promise<void>(() => { /* never */ }));
    expect(await provider.hasPendingSend("topic:x")).toBe(true);
  });

  test("a queue tail that already settled is nothing pending", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    (provider as any).queues.set("topic:x", Promise.resolve());
    expect(await provider.hasPendingSend("topic:x")).toBe(false);
  });

  test("the answer follows the tail: pending until it resolves, then not", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const tail = deferred();
    (provider as any).queues.set("topic:x", tail.promise);
    expect(await provider.hasPendingSend("topic:x")).toBe(true);
    tail.resolve();
    await settle();
    expect(await provider.hasPendingSend("topic:x")).toBe(false);
  });

  test("through sendChat: a send waiting behind a stuck one is seen while no process is alive", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const stuck = deferred();
    let call = 0;
    // No CLI is spawned: the stub holds the first turn open, like the send
    // that hung on 3019832f, and the second one waits on `await prev`.
    (provider as any).sendChatInternal = async () => {
      call += 1;
      if (call === 1) await stuck.promise;
      return { runId: `run-${call}` };
    };
    const first = provider.sendChat("topic:x", "msg1", {} as never);
    const second = provider.sendChat("topic:x", "msg2", {} as never);
    await settle();
    // The shape of the bug: liveness says nothing is running...
    expect(provider.isTurnProcessAlive("topic:x")).toBe(false);
    // ...and the queue says a send is still coming.
    expect(await provider.hasPendingSend("topic:x")).toBe(true);
    stuck.resolve();
    await Promise.all([first, second]);
    await settle();
    expect(await provider.hasPendingSend("topic:x")).toBe(false);
  });
});

describe("sessionHasPendingSend", () => {
  let tmpRoot: string;
  const clearRegistry = () => { for (const { name } of listProviders()) removeProvider(name); };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pending-send-"));
    initDatabase(tmpRoot);
    clearRegistry();
  });
  afterEach(() => {
    clearRegistry();
    try { closeDatabase(); } catch { /* already closed */ }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* scratch dir */ }
  });

  test("no provider exposes the probe: nothing pending", async () => {
    expect(await registry.sessionHasPendingSend("topic:x")).toBe(false);
  });

  test("a queued send counts even when the provider no longer holds a process for the session", async () => {
    // `killProcess` drops the session from `processes` while a send can still
    // be queued: gating on `ownsSession` would answer "nothing pending" in
    // exactly the 3019832f case.
    registerProvider({ type: "claude-code" });
    const provider = getProvider("claude-code") as unknown as { queues: Map<string, Promise<void>>; ownsSession(sk: string): boolean };
    provider.queues.set("topic:x", new Promise<void>(() => { /* never */ }));
    expect(provider.ownsSession("topic:x")).toBe(false);
    expect(await registry.sessionHasPendingSend("topic:x")).toBe(true);
    expect(await registry.sessionHasPendingSend("topic:other")).toBe(false);
  });
});

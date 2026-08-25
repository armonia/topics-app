/**
 * Tests for the per-session serial queue in ClaudeCodeProvider.sendChat
 * (claude-code.ts ~L787-803). Concurrent sendChat calls on the SAME session
 * must not overlap (they'd interleave stdin writes into one CLI child), and a
 * turn that THROWS must still hand the queue off to the next turn — otherwise
 * the session deadlocks (the `finally { resolveQueue() }` is what guarantees
 * this).
 *
 * We stub the private `sendChatInternal` so no real CLI is spawned: the queue
 * wrapper is the only thing under test.
  * @covers CCLI-03
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";

// Minimal deferred so a stubbed turn can be released on demand.
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const noopHandler = {} as never;

describe("ClaudeCodeProvider — per-session serial queue", () => {
  test("(a) two overlapping sendChat on the same session are serialized", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const events: string[] = [];
    const gate1 = deferred();

    // Stub the internal so we control exactly when each turn finishes.
    let call = 0;
    (provider as any).sendChatInternal = async () => {
      call += 1;
      const id = call;
      events.push(`start-${id}`);
      if (id === 1) await gate1.promise; // hold turn 1 open
      events.push(`end-${id}`);
      return { runId: `run-${id}` };
    };

    // Fire both without awaiting — turn 2 must queue behind turn 1.
    const p1 = provider.sendChat("sess-A", "msg1", noopHandler);
    const p2 = provider.sendChat("sess-A", "msg2", noopHandler);

    // Let microtasks flush: only turn 1 may have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start-1"]);

    // Release turn 1 → turn 2 proceeds.
    gate1.resolve();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  test("(b) a throwing turn still advances the queue (no deadlock)", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const events: string[] = [];

    let call = 0;
    (provider as any).sendChatInternal = async () => {
      call += 1;
      const id = call;
      events.push(`start-${id}`);
      if (id === 1) throw new Error("turn 1 blew up");
      events.push(`end-${id}`);
      return { runId: `run-${id}` };
    };

    const p1 = provider.sendChat("sess-B", "msg1", noopHandler);
    const p2 = provider.sendChat("sess-B", "msg2", noopHandler);

    // Turn 1 rejects to its caller...
    await expect(p1).rejects.toThrow("turn 1 blew up");
    // ...but the queue advanced: turn 2 ran to completion.
    await expect(p2).resolves.toEqual({ runId: "run-2" });
    expect(events).toEqual(["start-1", "start-2", "end-2"]);
  });

  test("different sessions do not block each other", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const events: string[] = [];
    const gateA = deferred();

    (provider as any).sendChatInternal = async (sessionKey: string) => {
      events.push(`start-${sessionKey}`);
      if (sessionKey === "sess-A") await gateA.promise;
      events.push(`end-${sessionKey}`);
      return {};
    };

    const pA = provider.sendChat("sess-A", "a", noopHandler);
    const pB = provider.sendChat("sess-B", "b", noopHandler);

    // sess-B is independent — it finishes while sess-A is still held.
    await pB;
    expect(events).toContain("end-sess-B");
    expect(events).not.toContain("end-sess-A");

    gateA.resolve();
    await pA;
    expect(events).toContain("end-sess-A");
  });
});

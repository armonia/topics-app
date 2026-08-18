/**
 * serial-queue — regression test for task e33820da.
 *
 * The bug: `chain()` in worktree-manager and task-automerge stored a `.finally()`
 * tail in the queue map. Under Bun an unhandled rejection terminates the process;
 * `.finally()` on a rejecting promise creates ANOTHER rejecting promise — the
 * tail — that nobody awaits. The fix: store `next.catch(() => undefined)` so the
 * map tail never rejects.
 *
 * Tests:
 *  1. Process survives a failing fn when the caller handles the error.
 *  2. Subsequent calls on the same key still run (queue keeps working).
 *  3. The internal map is GC-d after work completes (no memory leak).
 *  4. Concurrent calls on the same key are serialized (no interleaving).
 *  5. Different keys run independently (no cross-key blocking).
 */

import { describe, expect, it } from "bun:test";
import { makeSerialQueue } from "./serial-queue";

describe("makeSerialQueue", () => {
  it("caller handles rejection without killing the process", async () => {
    const q = makeSerialQueue();
    const err = new Error("git worktree add fallita");

    await expect(q.enqueue("key", () => Promise.reject(err))).rejects.toThrow(
      "git worktree add fallita",
    );

    // Process is still alive: a subsequent call works fine.
    const result = await q.enqueue("key", () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("queue continues serializing after a failure", async () => {
    const q = makeSerialQueue();
    const log: string[] = [];

    const p1 = q.enqueue("k", async () => {
      log.push("start-1");
      throw new Error("fail-1");
    });

    const p2 = q.enqueue("k", async () => {
      log.push("start-2");
      return "ok-2";
    });

    await p1.catch(() => {});
    const r2 = await p2;

    expect(log).toEqual(["start-1", "start-2"]);
    expect(r2).toBe("ok-2");
  });

  it("map is GC-d after all work settles (no leak)", async () => {
    const q = makeSerialQueue();

    const p1 = q.enqueue("a", () => Promise.resolve(1));
    const p2 = q.enqueue("b", () => Promise.resolve(2));
    await Promise.all([p1, p2]);

    // Allow the internal `void tail.then(...)` GC microtask to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(q.size()).toBe(0);
  });

  it("concurrent calls on the same key are strictly serialized", async () => {
    const q = makeSerialQueue();
    const order: number[] = [];
    let running = 0;

    function makeWork(id: number, ms: number) {
      return async () => {
        running++;
        expect(running).toBe(1); // no two run at once on the same key
        order.push(id);
        await new Promise<void>((res) => setTimeout(res, ms));
        running--;
      };
    }

    await Promise.all([
      q.enqueue("k", makeWork(1, 5)),
      q.enqueue("k", makeWork(2, 5)),
      q.enqueue("k", makeWork(3, 5)),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("different keys run in parallel (no cross-key blocking)", async () => {
    const q = makeSerialQueue();
    const started: string[] = [];

    let resolveA!: () => void;
    const blockA = new Promise<void>((res) => { resolveA = res; });

    const pA = q.enqueue("a", async () => {
      started.push("a");
      await blockA;
    });

    // Give "a" time to start.
    await Promise.resolve();

    const pB = q.enqueue("b", async () => {
      started.push("b");
    });

    await pB; // "b" must resolve even while "a" is still blocked.
    expect(started).toContain("a");
    expect(started).toContain("b");

    resolveA();
    await pA;
  });
});

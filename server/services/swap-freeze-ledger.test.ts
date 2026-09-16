/**
 * THE INVARIANT: NO PID IS SIGSTOPPED UNLESS IT IS ALREADY ON DISK.
 *
 * The failure it exists against is not hypothetical on this machine: a
 * `launchctl kickstart -k` is the documented emergency restart, and it SIGKILLs.
 * A server killed between the signal and the write leaves a tree stopped that
 * nobody can continue - it holds its memory, its gate slot and its `index.lock`
 * until the machine reboots.
 *
 * So the fake `kill` here reads the ledger FILE at every call and throws when it
 * is asked to stop a pid the file does not name yet, second walk included.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import { createSwapFreezeLedger, thawLedgerAtBoot, type LedgerFile, type LedgerIo } from "./swap-freeze-ledger";

function memoryIo(initial: string | null = null): LedgerIo & { text: () => string | null; logs: string[] } {
  let text = initial;
  const logs: string[] = [];
  return {
    read: () => text,
    write: (t) => { text = t; },
    log: (line) => { logs.push(line); },
    text: () => text,
    logs,
  };
}

const ref = (pid: number, lstart = `start-${pid}`) => ({ pid, lstart });

describe("F13: written before the signal, and only the same incarnation is continued", () => {
  test("a signal to a pid the file does not name is a defect the test can see", () => {
    const io = memoryIo();
    const ledger = createSwapFreezeLedger(io);
    const onDisk = (): LedgerFile => JSON.parse(io.text() ?? "{}") as LedgerFile;
    const kill = (pid: number): void => {
      const recorded = onDisk().active.flatMap((t) => t.batches.flatMap((b) => [...b.pids.map((p) => p.pid), ...b.groups.map((g) => g.pgid)]));
      if (!recorded.includes(Math.abs(pid))) throw new Error(`pid ${pid} was stopped before it was on disk`);
    };

    ledger.begin({ treeId: "t1", sessionKey: "topic:a", frozenAt: 1, root: ref(51000) });
    ledger.addBatch("t1", { groups: [{ pgid: 51000, leaderLstart: "start-51000" }], pids: [ref(51000), ref(51004)] });
    expect(() => { kill(-51000); kill(51004); }).not.toThrow();
    // The child forked between the two walks: signalling it before the second
    // batch is written is exactly the hole this closes.
    expect(() => kill(51010)).toThrow();
    ledger.addBatch("t1", { groups: [], pids: [ref(51010)] });
    expect(() => kill(51010)).not.toThrow();
  });

  test("the boot thaw continues matching identities and skips recycled pids", async () => {
    const io = memoryIo();
    const ledger = createSwapFreezeLedger(io);
    ledger.begin({ treeId: "t1", sessionKey: "topic:a", frozenAt: 1, root: ref(51000) });
    ledger.addBatch("t1", { groups: [{ pgid: 51000, leaderLstart: "start-51000" }], pids: [ref(51000), ref(51004)] });
    ledger.addBatch("t1", { groups: [], pids: [ref(51101)] });

    const sent: number[] = [];
    const out = await thawLedgerAtBoot({
      ledger,
      // 51004 has been recycled: same number, another process.
      lstartOf: async () => new Map([[51000, "start-51000"], [51004, "somebody-else"], [51101, "start-51101"]]),
      signal: (pid) => { sent.push(pid); },
      log: () => {},
    });
    // Leaves first, the root's group last.
    expect(sent).toEqual([51101, 51000, -51000]);
    expect(out.skipped).toBe(1);
    expect(JSON.parse(io.text()!).active).toEqual([]);
  });

  test("the counts survive the thaw and a reload; `active` does not", () => {
    const io = memoryIo();
    const first = createSwapFreezeLedger(io);
    first.begin({ treeId: "t1", sessionKey: "topic:a", frozenAt: 1, root: ref(51000) });
    first.addBatch("t1", { groups: [], pids: [ref(51000)] });
    expect(first.bumpCount(ref(51000), 10)).toBe(1);
    first.release("t1");

    const second = createSwapFreezeLedger(io);
    expect(second.snapshot().active).toEqual([]);
    expect(second.freezeCount(ref(51000)), "two per tree has to mean two, restarts included").toBe(1);
    expect(second.bumpCount(ref(51000), 20)).toBe(2);

    // The same number with another start time is another tree, from zero.
    expect(second.freezeCount(ref(51000, "another-start"))).toBe(0);
  });

  test("a count is forgotten when its root is gone", () => {
    const io = memoryIo();
    const ledger = createSwapFreezeLedger(io);
    ledger.bumpCount(ref(51000), 10);
    ledger.bumpCount(ref(60123), 11);
    ledger.pruneCounts((r) => r.pid === 60123);
    expect(ledger.snapshot().counts.map((c) => c.root.pid)).toEqual([60123]);
  });

  test("a corrupt ledger signals nothing and says so once", async () => {
    const io = memoryIo("{ this is not json");
    const ledger = createSwapFreezeLedger(io);
    expect(ledger.snapshot()).toEqual({ v: 1, active: [], counts: [] });
    expect(io.logs.join(" ")).toContain("[freeze] ledger unreadable");
    const sent: number[] = [];
    await thawLedgerAtBoot({ ledger, lstartOf: async () => new Map(), signal: (p) => { sent.push(p); }, log: () => {} });
    expect(sent).toEqual([]);
  });
});

/**
 * THE GOVERNOR, with fake signals: what it freezes, when, and what it says.
 *
 * Driven with an injected reading and an injected `signalTree` because the case
 * that matters is "Topics is over its budget", and reproducing that for real
 * would mean saturating the machine the suite is running on. What is NOT faked
 * is the registry: the entries are the same ones the check runner writes.
 *
 * @covers KANBAN-75
 */
import { describe, expect, it, afterEach } from "bun:test";
import {
  FROZEN_NOTE,
  _resetFreezableRuns,
  createBudgetGovernor,
  freezableRuns,
  registerFreezableRun,
} from "./budget-governor";

afterEach(() => { _resetFreezableRuns(); });

function harness(reading: { used: number; budget: number } | null) {
  const signals: string[] = [];
  const logs: string[] = [];
  const notes: { taskId: string; text: string }[] = [];
  const box = { reading };
  const governor = createBudgetGovernor({
    read: () => box.reading,
    signalTree: async (pid, sig) => { signals.push(`${sig}:${pid}`); },
    log: (m) => logs.push(m),
    note: (taskId, text) => notes.push({ taskId, text }),
  });
  return { governor, signals, logs, notes, box };
}

const addRun = (id: string, pid: number, startedAt: number, taskId?: string) => {
  const frozen = { at: 0, thawed: 0 };
  const off = registerFreezableRun({
    id, pid, name: id, taskId, startedAt,
    onFreeze: () => { frozen.at++; },
    onThaw: () => { frozen.thawed++; },
  });
  return { frozen, off };
};

describe("freezing", () => {
  it("one sample over the budget does nothing: a spike is not a state", async () => {
    const h = harness({ used: 12, budget: 9.6 });
    addRun("lint", 100, 1000);
    await h.governor.sampleOnce();
    expect(h.signals).toEqual([]);
    expect(h.governor.frozenCount()).toBe(0);
  });

  it("two in a row freeze the newest run, tell its card, and stop its clock", async () => {
    const h = harness({ used: 12, budget: 9.6 });
    addRun("typecheck", 100, 1000, "task-a");
    const newest = addRun("lint", 200, 2000, "task-b");

    await h.governor.sampleOnce();
    await h.governor.sampleOnce();

    expect(h.signals).toEqual(["SIGSTOP:200"]);
    expect(newest.frozen.at).toBe(1);
    expect(h.governor.frozenCount()).toBe(1);
    expect(h.notes).toEqual([{ taskId: "task-b", text: FROZEN_NOTE }]);
    expect(h.logs.some((l) => l.includes("congelo"))).toBe(true);
  });

  it("one victim per sample, never the whole board at once", async () => {
    const h = harness({ used: 30, budget: 9.6 });
    addRun("a", 1, 1000);
    addRun("b", 2, 2000);
    for (let i = 0; i < 4; i++) await h.governor.sampleOnce();
    // Four samples, two freezes: each one needs its own two readings.
    expect(h.signals).toEqual(["SIGSTOP:2", "SIGSTOP:1"]);
  });

  it("thaws in reverse order once the use is back under the line, and gives the clock back", async () => {
    const h = harness({ used: 30, budget: 9.6 });
    const first = addRun("a", 1, 1000);
    const second = addRun("b", 2, 2000);
    for (let i = 0; i < 4; i++) await h.governor.sampleOnce();
    expect(h.governor.frozenCount()).toBe(2);

    h.box.reading = { used: 5, budget: 9.6 };
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(h.signals.at(-1)).toBe("SIGCONT:1");
    expect(first.frozen.thawed).toBe(1);
    expect(second.frozen.thawed).toBe(0);
    expect(h.governor.frozenCount()).toBe(1);
  });

  it("a governor that cannot measure freezes nothing", async () => {
    const h = harness(null);
    addRun("lint", 100, 1000);
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(h.signals).toEqual([]);
  });

  it("a run that ended on its own is not signalled and leaves the registry", async () => {
    const h = harness({ used: 30, budget: 9.6 });
    const run = addRun("lint", 100, 1000);
    await h.governor.sampleOnce();
    run.off();
    await h.governor.sampleOnce();
    expect(h.signals).toEqual([]);
    expect(freezableRuns()).toHaveLength(0);
  });

  it("thawAll continues everything on the way out: nobody else will", async () => {
    const h = harness({ used: 30, budget: 9.6 });
    addRun("a", 1, 1000);
    addRun("b", 2, 2000);
    for (let i = 0; i < 4; i++) await h.governor.sampleOnce();
    await h.governor.thawAll();
    expect(h.signals.filter((s) => s.startsWith("SIGCONT"))).toEqual(["SIGCONT:1", "SIGCONT:2"]);
    expect(h.governor.frozenCount()).toBe(0);
  });
});

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
  BUDGET_FREEZE_MAX_MS,
  freezableRuns,
  registerFreezableRun,
  type FreezableRun,
} from "./budget-governor";

afterEach(() => { _resetFreezableRuns(); });

function harness(reading: { used: number; budget: number } | null, agentCommands?: () => Promise<FreezableRun[]>) {
  const signals: string[] = [];
  const logs: string[] = [];
  const notes: { taskId: string; text: string }[] = [];
  const box = { reading };
  const governor = createBudgetGovernor({
    read: () => box.reading,
    signalTree: async (pid, sig) => { signals.push(`${sig}:${pid}`); },
    log: (m) => logs.push(m),
    note: (taskId, text) => notes.push({ taskId, text }),
    agentCommands,
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

describe("review defects", () => {
  it("a run waiting for a gate slot is never the victim: it burns no CPU", async () => {
    const h = harness({ used: 30, budget: 9.6 });
    addRun("busy", 1, 1000);
    const waiting = { id: "waiting", pid: 2, name: "waiting", startedAt: 2000, queued: true };
    registerFreezableRun(waiting);
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(h.signals).toEqual(["SIGSTOP:1"]);
  });

  it("the card gets one note per run, however many times it is frozen", async () => {
    const h = harness({ used: 30, budget: 9.6 });
    addRun("a", 1, 1000, "task-a");
    await h.governor.sampleOnce(); await h.governor.sampleOnce();
    h.box.reading = { used: 1, budget: 9.6 };
    await h.governor.sampleOnce(); await h.governor.sampleOnce();
    h.box.reading = { used: 30, budget: 9.6 };
    await h.governor.sampleOnce(); await h.governor.sampleOnce();
    expect(h.signals).toEqual(["SIGSTOP:1", "SIGCONT:1", "SIGSTOP:1"]);
    expect(h.notes).toHaveLength(1);
  });

  it("a run frozen past the cap is continued even if the load never drops, and not frozen again", async () => {
    const h = harness({ used: 30, budget: 0.0001 });
    addRun("a", 1, 1000);
    await h.governor.sampleOnce(); await h.governor.sampleOnce();
    expect(h.governor.frozenCount()).toBe(1);
    const real = Date.now;
    Date.now = () => real() + BUDGET_FREEZE_MAX_MS + 1000;
    try {
      await h.governor.sampleOnce();
    } finally { Date.now = real; }
    expect(h.signals.at(-1)).toBe("SIGCONT:1");
    expect(h.governor.frozenCount()).toBe(0);
    await h.governor.sampleOnce(); await h.governor.sampleOnce(); await h.governor.sampleOnce();
    expect(h.signals.filter((x) => x.startsWith("SIGSTOP"))).toHaveLength(1);
  });
});

/** [28] The gates run inside the agents' own tree: the server's registry is empty, and the governor still has to act. */
describe("the commands the agents run in their own tree", () => {
  const command = (pid: number, startedAt: number, extra: Partial<FreezableRun> = {}): FreezableRun =>
    ({ id: `cmd:${pid}`, pid, name: `gate-${pid}`, startedAt, ...extra });

  it("with no server check alive, the newest command is frozen: the first ones finish", async () => {
    const live = [command(10, 1000), command(20, 2000)];
    const h = harness({ used: 12, budget: 9.6 }, async () => live);
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(h.signals).toEqual(["SIGSTOP:20"]);
    expect(h.governor.frozenIds()).toEqual(["cmd:20"]);
  });

  it("a server check goes before an agent command, even a newer command", async () => {
    addRun("typecheck", 5, 1000);
    const h = harness({ used: 12, budget: 9.6 }, async () => [command(30, 9000)]);
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(h.signals).toEqual(["SIGSTOP:5"]);
  });

  it("gives the command its own clock back, tells its card, and thaws it when the load drops", async () => {
    const hooks = { frozen: 0, thawed: 0 };
    const live = [command(20, 2000, { taskId: "task-z", onFreeze: () => { hooks.frozen++; }, onThaw: () => { hooks.thawed++; } })];
    const h = harness({ used: 12, budget: 9.6 }, async () => live);
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(hooks).toEqual({ frozen: 1, thawed: 0 });
    expect(h.notes).toEqual([{ taskId: "task-z", text: FROZEN_NOTE }]);
    h.box.reading = { used: 3, budget: 9.6 };
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(h.signals).toEqual(["SIGSTOP:20", "SIGCONT:20"]);
    expect(hooks.thawed).toBe(1);
  });

  it("is not even asked while the machine is within budget", async () => {
    let asked = 0;
    const h = harness({ used: 3, budget: 9.6 }, async () => { asked++; return [command(10, 1)]; });
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(asked).toBe(0);
  });

  it("a screen that doubts (fewer commands, or an error) never leaves a frozen command stopped", async () => {
    let answer: FreezableRun[] | Error = [command(20, 2000)];
    const h = harness({ used: 12, budget: 9.6 }, async () => { if (answer instanceof Error) throw answer; return answer; });
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(h.governor.frozenIds()).toEqual(["cmd:20"]);
    answer = [];
    await h.governor.sampleOnce();
    expect(h.governor.frozenIds()).toEqual(["cmd:20"]);
    answer = new Error("ps mute");
    h.box.reading = { used: 3, budget: 9.6 };
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    expect(h.signals).toEqual(["SIGSTOP:20", "SIGCONT:20"]);
  });

  it("a command frozen for the second time, which makes it immune, is still thawed by the plan", async () => {
    const h = harness({ used: 12, budget: 9.6 }, async () => [command(20, 2000)]);
    const samples = async (reading: { used: number; budget: number }) => {
      h.box.reading = reading;
      await h.governor.sampleOnce();
      await h.governor.sampleOnce();
    };
    await samples({ used: 12, budget: 9.6 });
    await samples({ used: 3, budget: 9.6 });
    await samples({ used: 12, budget: 9.6 });
    await samples({ used: 3, budget: 9.6 });
    expect(h.signals).toEqual(["SIGSTOP:20", "SIGCONT:20", "SIGSTOP:20", "SIGCONT:20"]);
    expect(h.governor.frozenCount()).toBe(0);
  });

  it("thawAll continues a frozen command on the way out", async () => {
    const h = harness({ used: 12, budget: 9.6 }, async () => [command(20, 2000)]);
    await h.governor.sampleOnce();
    await h.governor.sampleOnce();
    await h.governor.thawAll();
    expect(h.signals).toEqual(["SIGSTOP:20", "SIGCONT:20"]);
  });
});

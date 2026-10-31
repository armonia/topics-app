/**
 * @covers KANBAN-75
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { EMPTY_FREEZE_STATE, FREEZE_SETTLE_MS, freezePlan } from "../../shared/machine-budget";
import { budgetSample, computeDispatchCapacity, governorRead, newOtherLoadState, smoothedOther } from "../services/dispatch-capacity";
import { _resetFreezableRuns, createBudgetGovernor, registerFreezableRun } from "../services/budget-governor";
import { setActiveSwapFreezer, swapFrozenCount } from "./swap-freeze-hold";
import { _resetFleetUsageCache, _setMachineCpuSource, fleetLoadSync, getFleetUsage, type FleetLoadReading } from "./fleet-usage";

const targets = [{ id: "a", kind: "check" as const, startedAt: 1 }, { id: "b", kind: "check" as const, startedAt: 2 }];
const over = { used: 10, budget: 5, targets };

describe("card 10469e3e: a cached reading is one sample", () => {
  test("the same reading twice does not reach FREEZE_SAMPLES", () => {
    const first = freezePlan({ ...over, at: 1000 }, EMPTY_FREEZE_STATE);
    const again = freezePlan({ ...over, at: 1000 }, first.state);
    expect(again.freeze).toBeNull();
    const fresh = freezePlan({ ...over, at: 11_000 }, again.state);
    expect(fresh.freeze).toBe("b");
  });

  test("after a freeze, readings taken within the settle window do not count", () => {
    const st = freezePlan({ ...over, at: 1000 }, EMPTY_FREEZE_STATE).state;
    const act = freezePlan({ ...over, at: 2000 }, st);
    expect(act.freeze).toBe("b");
    const early1 = freezePlan({ ...over, at: 2000 + 5000 }, act.state);
    const early2 = freezePlan({ ...over, at: 2000 + FREEZE_SETTLE_MS }, early1.state);
    expect(early2.state.overSamples).toBe(0);
    const late1 = freezePlan({ ...over, at: 2000 + FREEZE_SETTLE_MS + 1 }, early2.state);
    const late2 = freezePlan({ ...over, at: 2000 + FREEZE_SETTLE_MS + 31_000 }, late1.state);
    expect(late2.freeze).toBe("a");
  });

  test("smoothedOther adds no sample for a reading it already has", () => {
    const st = newOtherLoadState();
    smoothedOther(1, st, 0, 100);
    for (let i = 1; i < 10; i++) smoothedOther(1, st, i * 1000, 100);
    expect(st.samples.length).toBe(1);
    smoothedOther(2, st, 30_000, 200);
    expect(st.samples.length).toBe(2);
  });

  test("fleetLoadSync serves the last reading while the refresh runs, and stamps it", async () => {
    _resetFleetUsageCache();
    const row = (cpu: number) => [{ pid: process.pid, ppid: 1, cpuSeconds: cpu, rssKB: 1000, command: "x" }] as never;
    await getFleetUsage(async () => row(1));
    const r = fleetLoadSync();
    expect(r?.at).toBeGreaterThan(0);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 40_000;
      expect(fleetLoadSync()).not.toBeNull();
      Date.now = () => realNow() + 90_000;
      expect(fleetLoadSync()).toBeNull();
    } finally { Date.now = realNow; _resetFleetUsageCache(); }
  });
});

describe("card 10469e3e: the beat refreshes the fleet reading before both consumers", () => {
  test("reconcile and the governor both wait for the same fresh reading", () => {
    const src = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
    const beat = src.slice(src.indexOf("const freshFleet = getFleetUsage()"));
    expect(beat.startsWith("const freshFleet")).toBe(true);
    expect(beat.slice(0, 900)).toContain("freshFleet\n      .then(() => taskDispatcher.reconcile");
    expect(beat.slice(0, 1800)).toContain("freshFleet.then(() => budgetGovernor.sampleOnce())");
  });
});

const reading = (other: number, at: number): FleetLoadReading => ({ cores: 12, coreUnits: 1, scriptsCoreUnits: 0, otherCoreUnits: other, memGB: 1, at });

describe("card 10469e3e: the identity travels through every wire", () => {
  test("the governor's read carries the fleet reading's `at`", () => {
    expect(governorRead(reading(1, 4242), 0.8, 20, 12, 32, 0).at).toBe(4242);
  });

  test("budgetSample: the same fleet reading read again adds no sample, a new one does", () => {
    const first = budgetSample(reading(2, 777_001), 20, 12, 32, 0).otherCoreUnits;
    for (let i = 0; i < 3; i++) expect(budgetSample(reading(100, 777_001), 20, 12, 32, 0).otherCoreUnits).toBe(first);
    expect(budgetSample(reading(100, 777_002), 20, 12, 32, 0).otherCoreUnits).not.toBe(first);
  });

  test("the capacity route reads the held value: asking it many times moves nothing", () => {
    const probe = () => reading(3, 888_001);
    const ask = () => computeDispatchCapacity(0, probe, true, () => 20, undefined, undefined, () => 10).otherCoreUnits;
    const first = ask();
    budgetSample(reading(100, 888_001), 20, 12, 32, 0);
    expect(ask()).toBe(first);
    expect(ask()).toBe(first);
  });

  test("the governor counts one reading once: the same `at` twice does not freeze, a fresh one does", async () => {
    _resetFreezableRuns();
    const signals: string[] = [];
    let at = 1000;
    const g = createBudgetGovernor({
      read: () => ({ used: 12, budget: 9.6, at }),
      signalTree: async (pid, sig) => { signals.push(`${sig}:${pid}`); },
      log: () => {},
      note: () => {},
    });
    const off = registerFreezableRun({ id: "r", pid: 9, name: "r", startedAt: 1, onFreeze: () => {}, onThaw: () => {} });
    try {
      await g.sampleOnce();
      await g.sampleOnce();
      expect(signals).toEqual([]);
      at = 11_000;
      await g.sampleOnce();
      expect(signals).toEqual(["SIGSTOP:9"]);
    } finally { off(); _resetFreezableRuns(); }
  });

  test("after a thaw the settle window also holds: the effect is measured before the next action", () => {
    const frozenState = { overSamples: 0, underSamples: 1, frozen: ["a"], lastAt: 1000 };
    const thaw = freezePlan({ used: 0, budget: 10, targets, at: 2000 }, frozenState);
    expect(thaw.thaw).toBe("a");
    expect(thaw.state.notBefore).toBe(2000 + FREEZE_SETTLE_MS);
    const early = freezePlan({ ...over, at: 2000 + 3000 }, thaw.state);
    expect(early.state.overSamples).toBe(0);
  });
});

describe("card 10469e3e: the fleet reading stamp and the kernel floor", () => {
  const rows = (own: number, other: number) => [
    { pid: process.pid, ppid: 1, cpu: 0, cpuSeconds: own, rssKB: 1000, command: "bun server.ts" },
    { pid: 424242, ppid: 1, cpu: 0, cpuSeconds: other, rssKB: 1000, command: "/usr/bin/somebody" },
  ] as never;

  afterEach(() => { _setMachineCpuSource(null); _resetFleetUsageCache(); });

  test("`at` is taken when the read ends, not when it starts", async () => {
    _resetFleetUsageCache();
    _setMachineCpuSource(() => null);
    const realNow = Date.now;
    let clock = realNow();
    try {
      Date.now = () => clock;
      await getFleetUsage(async () => rows(1, 1));
      clock += 5000;
      const started = clock;
      await getFleetUsage(async () => { clock += 150; return rows(2, 1); });
      expect(fleetLoadSync()?.at).toBe(started + 150);
    } finally { Date.now = realNow; }
  });

  test("the others' CPU is never below the kernel's machine figure minus ours (short-lived processes)", async () => {
    _resetFleetUsageCache();
    const realNow = Date.now;
    let clock = realNow();
    try {
      Date.now = () => clock;
      _setMachineCpuSource(() => 90);
      await getFleetUsage(async () => rows(1, 1));
      clock += 30_000;
      // ps sees almost nothing (the heavy processes were born and died between readings): the kernel says 90%.
      await getFleetUsage(async () => rows(1.1, 1.1));
      const r = fleetLoadSync()!;
      expect(r.otherCoreUnits).toBeGreaterThan(0.5);
      _setMachineCpuSource(() => null);
    } finally { Date.now = realNow; }
  });
});

describe("card 10469e3e: one CPU budget and every freeze in the capacity payload", () => {
  const quiet = () => reading(1, 999_001);
  const cap = (knob: { share: number; frozen: number; swapFrozen?: number; resources?: boolean }) =>
    computeDispatchCapacity(2, quiet, true, () => 20, knob, undefined, () => 10);

  test("in resources mode budgetCores is the knob's budget, not half of the free", () => {
    const c = cap({ share: 0.8, frozen: 0, resources: true });
    expect(c.budgetCores).toBe(c.budgetCoreUnits);
    const counted = cap({ share: 0.8, frozen: 0 });
    expect(counted.budgetCores).not.toBe(counted.budgetCoreUnits);
  });

  test("frozen sums the governor and the swap freezer, with the detail of who", () => {
    const c = cap({ share: 0.8, frozen: 1, swapFrozen: 2 });
    expect(c.frozen).toBe(3);
    expect(c.frozenBy).toEqual({ governor: 1, swapFreezer: 2 });
  });

  test("in resources mode recommended and the reason come from the knob's budget", () => {
    // Nothing running and our own CPU at 0, so the slots are the knob's usable CPU over a fixed price per agent.
    // The price is derived from the machine's own usable figure (clamped to the price list's band), so a high and a
    // low knob land on different slot counts on any core count.
    const idle = { ...reading(1, 999_002), coreUnits: 0 };
    const run = (share: number, price: number, resources: boolean) =>
      computeDispatchCapacity(0, () => idle, true, () => 20, { share, frozen: 0, resources }, { coreUnits: () => [price], memGB: () => [] }, () => 10);
    const price = Math.min(4, Math.max(0.5, run(0.8, 1, true).usableCoreUnits / 4));
    const hi = run(0.8, price, true);
    const lo = run(0.1, price, true);
    const slots = (c: { usableCoreUnits: number }) => Math.min(8, Math.max(1, Math.floor(c.usableCoreUnits / price)));
    expect(hi.recommended).toBe(slots(hi));
    expect(lo.recommended).toBe(slots(lo));
    expect(hi.recommended).toBeGreaterThan(lo.recommended);
    expect(hi.reason).toContain("utilizzabili");
    // Count mode ignores the knob: same answer for both values, and the quota phrase instead.
    const c1 = run(0.8, price, false);
    const c2 = run(0.1, price, false);
    expect(c1.recommended).toBe(c2.recommended);
    expect(c1.reason).toContain("di quota");
    expect(c1.reason).not.toContain("utilizzabili");
  });

  test("swapFrozenCount reads the active freezer and is 0 without one", () => {
    try {
      setActiveSwapFreezer({ frozenCount: () => 2 } as unknown as Parameters<typeof setActiveSwapFreezer>[0]);
      expect(swapFrozenCount()).toBe(2);
    } finally { setActiveSwapFreezer(null); }
    expect(swapFrozenCount()).toBe(0);
  });

  test("the capacity route feeds the knob with the swap freezer and the resources mode", () => {
    const routes = readFileSync(join(import.meta.dir, "../routes/tasks.ts"), "utf8");
    // Match only live lines: a commented-out line must turn this red.
    expect(routes).toMatch(/^\s*swapFrozen: swapFrozenCount\(\),\s*$/m);
    expect(routes).toMatch(/^\s*resources: capMode\(svc\.getGlobalCap\(\)\) === "resources",\s*$/m);
  });
});

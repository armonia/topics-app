/**
 * The whole-Mac CPU% the "Mac is X% busy" number is made of, and the two
 * capacity fields that carry it (`machineCpuPct`, `machineMemPct`).
 * @covers KANBAN-07
 */
import { describe, expect, test } from "bun:test";
import { busyPctBetween, createMachineCpuSampler, sumTicks } from "./machine-cpu";
import { computeDispatchCapacity, machinePercents } from "../services/dispatch-capacity";

const core = (busy: number, idle: number) => ({ times: { user: busy, nice: 0, sys: 0, irq: 0, idle } });

describe("tick counters", () => {
  test("busy over total between two readings, all cores together", () => {
    const a = sumTicks([core(100, 100), core(100, 100)]);
    // Core one fully busy for 100 ticks, core two idle: half the machine.
    const b = sumTicks([core(200, 100), core(100, 200)]);
    expect(busyPctBetween(a, b)).toBe(50);
  });

  test("an empty list is not a machine at 0%", () => {
    expect(sumTicks([])).toBeNull();
    expect(sumTicks(null)).toBeNull();
  });

  test("counters that go backwards say nothing", () => {
    expect(busyPctBetween({ busy: 10, total: 20 }, { busy: 5, total: 30 })).toBeNull();
    expect(busyPctBetween({ busy: 10, total: 20 }, { busy: 10, total: 20 })).toBeNull();
  });
});

describe("the sampler", () => {
  test("first reading answers with the fallback, the next one with the ticks", () => {
    let now = 0;
    const reads = [[core(10, 10)], [core(85, 35)]];
    const s = createMachineCpuSampler(() => reads.shift() ?? null, () => now);
    expect(s(12.4)).toBe(12);
    now = 5_000;
    expect(s(12.4)).toBe(75);
  });

  test("nothing to diff and no fallback is not measured, never zero", () => {
    const s = createMachineCpuSampler(() => [core(1, 1)], () => 0);
    expect(s(null)).toBeNull();
  });

  test("a short core list under load restarts the base instead of inventing a spike", () => {
    let now = 0;
    const reads = [[core(1, 1), core(1, 1)], [core(1_000_000, 1)], [core(1_000_100, 101)]];
    const s = createMachineCpuSampler(() => reads.shift() ?? null, () => { now += 5_000; return now; });
    s(null);
    expect(s(null)).toBeNull();
    expect(s(null)).toBe(50);
  });
});

describe("machinePercents, the two fields on the wire", () => {
  test("memory is the share NOT available, CPU is what the sampler says", () => {
    expect(machinePercents(null, 8, 12, 32, () => 41)).toEqual({ machineCpuPct: 41, machineMemPct: 75 });
  });

  test("memory not measured (off macOS) stays null", () => {
    expect(machinePercents(null, null, 12, 32, () => 41).machineMemPct).toBeNull();
  });

  test("the fallback handed to the sampler is the RAW fleet sum over the whole machine", () => {
    let seen: number | null = -1;
    machinePercents({ coreUnits: 1, scriptsCoreUnits: 2, otherCoreUnits: 3, cores: 12, memGB: 4 }, 8, 12, 32, (f) => { seen = f; return f; });
    expect(seen).toBe(50);
  });

  test("a sampler that throws is not measured, not a dropped reading", () => {
    expect(machinePercents(null, 8, 12, 32, () => { throw new Error("x"); }).machineCpuPct).toBeNull();
  });

  test("the capacity reading carries both", () => {
    const c = computeDispatchCapacity(0, () => null, true, () => 4, undefined, undefined, () => 63);
    expect(c.machineCpuPct).toBe(63);
    expect(c.machineMemPct).not.toBeNull();
    expect(c.machineMemPct!).toBeGreaterThan(0);
    expect(c.machineMemPct!).toBeLessThanOrEqual(100);
  });
});

/**
 * @covers KANBAN-75
 */
import { describe, expect, test } from "bun:test";
import { EMPTY_FREEZE_STATE, FREEZE_SETTLE_MS, freezePlan } from "../../shared/machine-budget";
import { newOtherLoadState, smoothedOther } from "../services/dispatch-capacity";
import { _resetFleetUsageCache, fleetLoadSync, getFleetUsage } from "./fleet-usage";

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

/**
 * The provider hold: one memo for every clock that would otherwise find out on
 * its own that the plan's window is spent.
 *
 * @covers RESUME-04
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerHold, setProviderHold, clearProviderHold, onProviderHold, holdUntilLabel, configureProviderHoldStore, resetProviderHoldStore, planUsage, recordPlanUsage, onPlanUsage, clearPlanUsage } from "./provider-hold";
import { PLAN_DISPATCH_HOLD_AT, PLAN_USAGE_WARN_AT } from "../../shared/provider-hold";

const NOW = 1_800_000_000_000;

describe("the hold survives a restart (mirrored on disk)", () => {
  let dir = "";
  beforeEach(() => { clearProviderHold(); dir = mkdtempSync(join(tmpdir(), "provider-hold-")); });
  afterEach(() => { clearProviderHold(); resetProviderHoldStore(); rmSync(dir, { recursive: true, force: true }); });

  test("set writes the memo, clear removes it", () => {
    const path = join(dir, "state", "provider-hold.json");
    expect(configureProviderHoldStore(path, NOW)).toBeNull();
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "finestra di 5 ore esaurita" }, NOW);
    expect(JSON.parse(readFileSync(path, "utf8")).untilMs).toBe(NOW + 60_000);
    clearProviderHold();
    expect(existsSync(path)).toBe(false);
  });

  test("the next process adopts a hold that has not ended, and tells its listeners", () => {
    const path = join(dir, "provider-hold.json");
    writeFileSync(path, JSON.stringify({ untilMs: NOW + 3_600_000, window: "seven_day", reason: "finestra settimanale esaurita", sinceMs: NOW - 1000 }));
    const seen: (number | null)[] = [];
    onProviderHold((h) => seen.push(h?.untilMs ?? null));
    const restored = configureProviderHoldStore(path, NOW);
    expect(restored?.reason).toBe("finestra settimanale esaurita");
    expect(providerHold(NOW)?.window).toBe("seven_day");
    expect(seen).toEqual([NOW + 3_600_000]);
  });

  test("an expired or unreadable memo is removed, not adopted", () => {
    const expired = join(dir, "expired.json");
    writeFileSync(expired, JSON.stringify({ untilMs: NOW - 1, window: "five_hour", reason: "ieri" }));
    expect(configureProviderHoldStore(expired, NOW)).toBeNull();
    expect(existsSync(expired)).toBe(false);
    const garbage = join(dir, "garbage.json");
    writeFileSync(garbage, "{not json");
    expect(configureProviderHoldStore(garbage, NOW)).toBeNull();
    expect(existsSync(garbage)).toBe(false);
    expect(providerHold(NOW)).toBeNull();
  });
});

describe("provider hold", () => {
  beforeEach(() => { clearProviderHold(); resetProviderHoldStore(); });

  test("a hold is in force until its end, then forgotten by itself", () => {
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "finestra di 5 ore del piano esaurita" }, NOW);
    expect(providerHold(NOW)?.untilMs).toBe(NOW + 60_000);
    expect(providerHold(NOW + 59_999)).not.toBeNull();
    expect(providerHold(NOW + 60_000)).toBeNull();
  });

  test("a later end replaces an earlier one; a shorter one does not shorten it", () => {
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "a" }, NOW);
    setProviderHold({ untilMs: NOW + 120_000, window: "seven_day", reason: "b" }, NOW);
    expect(providerHold(NOW)?.reason).toBe("b");
    setProviderHold({ untilMs: NOW + 30_000, window: "five_hour", reason: "c" }, NOW);
    expect(providerHold(NOW)?.reason).toBe("b");
  });

  test("a successful request lifts it, and the listeners hear both ends", () => {
    const seen: (number | null)[] = [];
    const off = onProviderHold((h) => seen.push(h?.untilMs ?? null));
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "a" }, NOW);
    clearProviderHold();
    clearProviderHold(); // idempotent: no second null
    off();
    setProviderHold({ untilMs: NOW + 60_000, window: "five_hour", reason: "a" }, NOW);
    expect(seen).toEqual([NOW + 60_000, null]);
  });

  test("the label is an hour a person reads", () => {
    expect(holdUntilLabel({ untilMs: NOW })).toMatch(/^\d{2}:\d{2}$/);
  });
});

/**
 * HOW FULL the window is, which the hold does not answer.
 *
 * @covers USAGE-21
 */
describe("the plan-usage memo", () => {
  beforeEach(() => { clearPlanUsage(); });
  afterEach(() => { clearPlanUsage(); });

  test("no reading at all is not an empty window", () => {
    expect(planUsage(NOW)).toBeNull();
  });

  test("the newest reading wins, even when it is lower", () => {
    // Unlike the hold there is no longer-wall-wins here: a window that reset
    // genuinely goes back to nearly empty, and a memo that only ever climbed
    // would brake the queue for good.
    recordPlanUsage({ fiveHour: { utilization: 92, resetsAtMs: NOW + 60_000 }, sevenDay: null }, NOW);
    recordPlanUsage({ fiveHour: { utilization: 4, resetsAtMs: NOW + 5 * 3_600_000 }, sevenDay: null }, NOW + 1);
    expect(planUsage(NOW + 1)?.fiveHour?.utilization).toBe(4);
    expect(planUsage(NOW + 1)?.observedAtMs).toBe(NOW + 1);
  });

  test("a window past its own reset drops out, one at a time", () => {
    recordPlanUsage({
      fiveHour: { utilization: 92, resetsAtMs: NOW + 60_000 },
      sevenDay: { utilization: 40, resetsAtMs: NOW + 600_000 },
    }, NOW);
    expect(planUsage(NOW + 60_000)?.fiveHour).toBeNull();
    expect(planUsage(NOW + 60_000)?.sevenDay?.utilization).toBe(40);
    expect(planUsage(NOW + 600_000)).toBeNull();
  });

  test("a reading without a reset instant never expires by itself", () => {
    recordPlanUsage({ fiveHour: { utilization: 55, resetsAtMs: null }, sevenDay: null }, NOW);
    expect(planUsage(NOW + 86_400_000)?.fiveHour?.utilization).toBe(55);
  });

  test("the listeners hear every reading and the clearing", () => {
    const seen: (number | null)[] = [];
    const off = onPlanUsage((u) => seen.push(u?.fiveHour?.utilization ?? null));
    recordPlanUsage({ fiveHour: { utilization: 12, resetsAtMs: NOW + 60_000 }, sevenDay: null }, NOW);
    clearPlanUsage();
    clearPlanUsage(); // idempotent: no second null
    off();
    recordPlanUsage({ fiveHour: { utilization: 12, resetsAtMs: NOW + 60_000 }, sevenDay: null }, NOW);
    expect(seen).toEqual([12, null]);
  });

  test("the two thresholds keep their order, and both sit under exhaustion", () => {
    expect(PLAN_USAGE_WARN_AT).toBeLessThan(PLAN_DISPATCH_HOLD_AT);
    expect(PLAN_DISPATCH_HOLD_AT).toBeLessThan(100);
  });
});

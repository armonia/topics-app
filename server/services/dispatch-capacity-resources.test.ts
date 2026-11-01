/**
 * The "by resources" recommendation: running + floor((usable - ours) / price),
 * clamped to 1..MAX_AUTO_CAP. Each case pins one term of that formula, on any
 * core count: the expectations are computed from the machine's own core count.
 * @covers KANBAN-75
 */
import { afterEach, describe, expect, test } from "bun:test";
import { computeDispatchCapacity } from "./dispatch-capacity";
import type { FleetLoadReading } from "../lib/fleet-usage";

const cores = computeDispatchCapacity(0, () => null).cores;
const MAX_AUTO_CAP = 8;
const clampSlots = (n: number) => Math.min(MAX_AUTO_CAP, Math.max(1, n));

// somebody else's CPU is smoothed over a 45 s window shared by the whole process:
// each case runs on a clock a minute and a half after the last, so it sees only its own reading.
const realNow = Date.now;
const shared = globalThis as { __otherClock?: number };
let at = 31_000_000;
afterEach(() => { Date.now = realNow; });

function ask(o: { running: number; ours: number; other: number; share: number; price: number }) {
  // One clock for every test file in the process, always ahead of the last reading anybody took.
  const clock = shared.__otherClock = Math.max(shared.__otherClock ?? 0, realNow()) + 100_000;
  Date.now = () => clock;
  const reading: FleetLoadReading = { cores, coreUnits: o.ours, scriptsCoreUnits: 0, otherCoreUnits: o.other, memGB: 1, at: ++at };
  return computeDispatchCapacity(
    o.running, () => reading, true, () => 20,
    { share: o.share, frozen: 0, resources: true },
    { coreUnits: () => [o.price], memGB: () => [] },
    () => 10,
  );
}

describe("resources mode: every term of the recommendation", () => {
  test("somebody else's CPU shrinks the usable budget (it is not the plain share of the machine)", () => {
    const c = ask({ running: 3, ours: 0, other: cores, share: 0.95, price: 0.5 });
    expect(c.usableCoreUnits).toBe(0);
    expect(c.budgetCoreUnits).toBeGreaterThan(c.usableCoreUnits);
    expect(c.recommended).toBe(3);
  });

  test("the agents already running are added to the free slots", () => {
    const c = ask({ running: 3, ours: 0, other: 0, share: 0.1, price: 4 });
    expect(c.recommended).toBe(clampSlots(3 + Math.floor((cores * 0.1) / 4)));
    expect(c.recommended).toBeGreaterThanOrEqual(3);
  });

  test("what our agents already burn is spent: it comes off the usable budget", () => {
    const c = ask({ running: 2, ours: cores * 0.95, other: 0, share: 0.95, price: 0.5 });
    expect(c.recommended).toBe(2);
  });

  test("the ceiling holds however many agents are running", () => {
    const c = ask({ running: 20, ours: 0, other: 0, share: 0.95, price: 0.5 });
    expect(c.recommended).toBe(MAX_AUTO_CAP);
  });
});

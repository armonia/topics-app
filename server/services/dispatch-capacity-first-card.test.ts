/**
 * THE MEMORY FLOOR'S "FIRST CARD" EXEMPTION, and the disk that does not get one.
 *
 * Measured on 1455 `[memsig]` lines over 25.7 h of 16-17/09/2026: `held2m >= 6
 * GB` ZERO times, the instant reading above 6 GB 11 times out of 1444 and never
 * twice in a row, while the floor asks for at least 12-13 consecutive readings
 * over the line. Seven cards still for 45 to 51 hours, 314 comments saying
 * "Memoria quasi finita", one single restart in 26 hours and only because a
 * person closed some apps. Every sample printed `inFlight=0 checkRuns=0`: the
 * RAM was not Topics', and the floor had no way out at all.
 *
 * Its own file rather than a block inside `dispatch-capacity.test.ts` because
 * that one is already up against the `check:bloat` threshold.
 *
 * @covers KANBAN-75
 */
import { describe, expect, test } from "bun:test";
import { dispatchResourceVerdict, type MemoryFloorHold } from "./dispatch-capacity";
import type { HeldMemory } from "./mem-signal";

/** A full 2-minute window whose lowest reading is `gb`. */
const held = (gb: number): (() => HeldMemory) => () =>
  ({ measurable: true, latestGB: gb, heldGB: gb, coveredMs: 120_000 });

describe("il pavimento della memoria cede alla prima card, il disco no", () => {
  const disco = () => 500;
  const fermo: MemoryFloorHold = { cardGB: 4, reservedGB: 0, reservedCards: 0, ourWorkRunning: false };
  const alLavoro: MemoryFloorHold = { ...fermo, ourWorkRunning: true };

  test("a Topics fermo una card parte anche sotto il pavimento, e il verdetto lo dichiara", () => {
    const v = dispatchResourceVerdict("/tmp", disco, held(4.8), false, fermo);
    expect(v.reason).toBeNull();
    expect(v.kind).toBeNull();
    expect(v.memoryFirstCardExempt).toBe(true);
  });

  test("con un agente al lavoro il pavimento vale pieno", () => {
    const v = dispatchResourceVerdict("/tmp", disco, held(4.8), false, alLavoro);
    expect(v.reason).toContain("Memoria quasi finita");
    expect(v.kind).toBe("memory");
    expect(v.memoryFirstCardExempt).toBe(false);
  });

  test("anche la finestra ancora vuota cede alla prima card, e trattiene con un agente vivo", () => {
    // Holding on "I do not know yet" while admitting on a reading that is
    // measured and bad would say the unknown is worse than the bad.
    const window = () => ({ measurable: true, latestGB: 20, heldGB: null, coveredMs: 40_000 });
    expect(dispatchResourceVerdict("/tmp", disco, window, false, fermo).memoryFirstCardExempt).toBe(true);
    const busy = dispatchResourceVerdict("/tmp", disco, window, false, alLavoro);
    expect(busy.kind).toBe("memory_warmup");
    expect(busy.reason).toContain("la sto misurando");
  });

  test("il disco non ha esenzione: a macchina ferma resta chiuso", () => {
    // A full disk does not reabsorb itself and SQLite's writes fail: it waits
    // for a person, and no count of agents opens it.
    const v = dispatchResourceVerdict("/tmp", () => 1, held(50), false, fermo);
    expect(v.kind).toBe("disk");
    expect(v.reason).toContain("Disco quasi pieno");
    expect(v.memoryFirstCardExempt).toBe(false);
  });

  test("memoria abbondante non è un'esenzione: non c'era niente da graziare", () => {
    // The boundary that keeps the declaration honest: above the floor the
    // verdict must say "nothing held", not "I waived one".
    const v = dispatchResourceVerdict("/tmp", disco, held(20), false, fermo);
    expect(v.reason).toBeNull();
    expect(v.memoryFirstCardExempt).toBe(false);
  });
});

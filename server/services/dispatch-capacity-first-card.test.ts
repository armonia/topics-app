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

describe("il pavimento della memoria cede alla prima card, il disk no", () => {
  const disk = () => 500;
  const idle: MemoryFloorHold = { cardGB: 4, reservedGB: 0, reservedCards: 0, spendingHere: false, ourWorkRunning: false };
  const atWork: MemoryFloorHold = { ...idle, spendingHere: true, ourWorkRunning: true };

  test("a Topics idle una card parte anche sotto il pavimento, e il verdetto lo dichiara", () => {
    const v = dispatchResourceVerdict("/tmp", disk, held(4.8), false, idle);
    expect(v.reason).toBeNull();
    expect(v.kind).toBeNull();
    expect(v.memoryFirstCardExempt).toBe(true);
  });

  test("con un agente al lavoro il pavimento vale pieno", () => {
    const v = dispatchResourceVerdict("/tmp", disk, held(4.8), false, atWork);
    expect(v.reason).toContain("Memoria quasi finita");
    expect(v.kind).toBe("memory");
    expect(v.memoryFirstCardExempt).toBe(false);
  });

  test("anche la finestra ancora vuota cede alla prima card, e trattiene con un agente vivo", () => {
    // Holding on "I do not know yet" while admitting on a reading that is
    // measured and bad would say the unknown is worse than the bad.
    const window = () => ({ measurable: true, latestGB: 20, heldGB: null, coveredMs: 40_000 });
    expect(dispatchResourceVerdict("/tmp", disk, window, false, idle).memoryFirstCardExempt).toBe(true);
    const busy = dispatchResourceVerdict("/tmp", disk, window, false, atWork);
    expect(busy.kind).toBe("memory_warmup");
    expect(busy.reason).toContain("la sto misurando");
  });

  test("il disk non ha esenzione: a macchina ferma resta chiuso", () => {
    // A GUARD, NOT A PROOF, and it should be read that way: the disk did not
    // change with KANBAN-75 and this case passes identically on the code from
    // before the exemption. It demonstrates nothing new; it pins the asymmetry
    // the requirement decided, and goes red only if somebody extends the
    // memory derogation to the disk.
    //
    // A full disk does not reabsorb itself and SQLite's writes fail: it waits
    // for a person, and no count of agents opens it.
    const v = dispatchResourceVerdict("/tmp", () => 1, held(50), false, idle);
    expect(v.kind).toBe("disk");
    expect(v.reason).toContain("Disco quasi pieno");
    expect(v.memoryFirstCardExempt).toBe(false);
  });

  test("memoria abbondante non è un'esenzione: non c'era niente da graziare", () => {
    // The boundary that keeps the declaration honest: above the floor the
    // verdict must say "nothing held", not "I waived one".
    const v = dispatchResourceVerdict("/tmp", disk, held(20), false, idle);
    expect(v.reason).toBeNull();
    expect(v.memoryFirstCardExempt).toBe(false);
  });
});

/**
 * THE 6-10 GB BAND, which is where this Mac lives while it frees up.
 *
 * The census ("is any of ours alive here?") and the price list ("is any of ours
 * still going to spend here?") answer differently about the cards parked on
 * GitHub's CI, and the line took its BRANCH from the first and its FIGURE from
 * the second: branch "floor + price + reservation", reservation 0, so 10 GB
 * asked of a machine where nothing of ours was spending. With two off-lane
 * cards in flight - the normal state of a delivery for about fifteen minutes -
 * 7.0, 8.0 and 9.9 GB of `held2m` all held, so a delivery that had just passed
 * its local checks stopped the queue harder than an agent at work.
 */
describe("un solo censimento: la riga la decide il listino", () => {
  const disk = () => 500;
  /** Cards in flight, alive and resident, whose checks here are over. */
  const sullaCI: MemoryFloorHold = { cardGB: 4, reservedGB: 0, reservedCards: 0, spendingHere: false, ourWorkRunning: true };
  /** A turn still running commands here: the price list charges it. */
  const spending: MemoryFloorHold = { ...sullaCI, spendingHere: true };

  for (const gb of [7.0, 8.0, 9.9]) {
    test(`a ${gb.toFixed(1)} GB, sopra il pavimento e con solo card sulla CI, la prossima parte`, () => {
      const v = dispatchResourceVerdict("/tmp", disk, held(gb), false, sullaCI);
      expect(v.reason).toBeNull();
      // And NOT by derogation: the reading really is over the floor, not waived.
      expect(v.memoryFirstCardExempt).toBe(false);
    });
  }

  test("sotto il pavimento resta chiusa, e senza esenzione: le card sulla CI sono nostre", () => {
    // The census fix stands: an off-lane card is an agent alive and resident,
    // so the first-card derogation does NOT re-arm underneath it.
    const v = dispatchResourceVerdict("/tmp", disk, held(4.8), false, sullaCI);
    expect(v.kind).toBe("memory");
    expect(v.reason).toContain("sotto il pavimento di 6 GB");
    expect(v.memoryFirstCardExempt).toBe(false);
  });

  test("un turno che spende ancora qui alza la riga a 10 GB, e la cifra è quella del listino", () => {
    const v = dispatchResourceVerdict("/tmp", disk, held(9.9), false, spending);
    expect(v.reason).toContain("sotto i 10.0 GB");
    expect(dispatchResourceVerdict("/tmp", disk, held(10.0), false, spending).reason).toBeNull();
    // With a reservation (count mode) the figure rises with it, branch and
    // figure off the same list: 6 + 4 + 4.
    const withReservation = { ...spending, reservedGB: 4, reservedCards: 1 };
    expect(dispatchResourceVerdict("/tmp", disk, held(13.9), false, withReservation).reason).toContain("sotto i 14.0 GB");
    expect(dispatchResourceVerdict("/tmp", disk, held(14.0), false, withReservation).reason).toBeNull();
  });
});

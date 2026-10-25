/**
 * Machine-wide floor behavior stays independent of card-specific exemptions.
 *
 * @covers KANBAN-75
 */
import { describe, expect, test } from "bun:test";
import { dispatchResourceVerdict, readOnlyMemoryReservationGB, type MemoryFloorHold } from "./dispatch-capacity";
import type { HeldMemory } from "./mem-signal";

/** A full 2-minute window whose lowest reading is `gb`. */
const held = (gb: number): (() => HeldMemory) => () =>
  ({ measurable: true, latestGB: gb, heldGB: gb, coveredMs: 120_000 });

describe("the machine-wide resource floor", () => {
  const disk = () => 500;
  const idle: MemoryFloorHold = { cardGB: 4, reservedGB: 0, reservedCards: 0, spendingHere: false, ourWorkRunning: false };
  const atWork: MemoryFloorHold = { ...idle, spendingHere: true, ourWorkRunning: true };

  test("the global floor never grants a card-specific exception", () => {
    const v = dispatchResourceVerdict("/tmp", disk, held(4.8), false, idle);
    expect(v.reason).toContain("Memoria quasi finita");
    expect(v.kind).toBe("memory");
    expect(v.memoryFirstCardExempt).toBe(false);
  });

  test("native and CLI floors remain at 6 GB and 12 GB", () => {
    expect(dispatchResourceVerdict("/tmp", disk, held(5.9), false, idle).kind).toBe("memory");
    expect(dispatchResourceVerdict("/tmp", disk, held(6), false, idle).reason).toBeNull();
    expect(dispatchResourceVerdict("/tmp", disk, held(11.9), true, idle).kind).toBe("memory");
    expect(dispatchResourceVerdict("/tmp", disk, held(12), true, idle).reason).toBeNull();
  });

  test("read-only reservations round both runtimes up to 1 GB", () => {
    expect(readOnlyMemoryReservationGB(false)).toBe(1);
    expect(readOnlyMemoryReservationGB(true)).toBe(1);
  });

  test("a live agent still raises the normal floor line", () => {
    const v = dispatchResourceVerdict("/tmp", disk, held(4.8), false, atWork);
    expect(v.reason).toContain("Memoria quasi finita");
    expect(v.kind).toBe("memory");
    expect(v.memoryFirstCardExempt).toBe(false);
  });

  test("an incomplete memory window holds the machine-wide floor", () => {
    const window = () => ({ measurable: true, latestGB: 20, heldGB: null, coveredMs: 40_000 });
    const unknown = dispatchResourceVerdict("/tmp", disk, window, false, idle);
    expect(unknown.kind).toBe("memory_warmup");
    expect(unknown.memoryFirstCardExempt).toBe(false);
    const busy = dispatchResourceVerdict("/tmp", disk, window, false, atWork);
    expect(busy.kind).toBe("memory_warmup");
    expect(busy.reason).toContain("la sto misurando");
  });

  test("a full worktree disk stays blocked", () => {
    const v = dispatchResourceVerdict("/tmp", () => 1, held(50), false, idle);
    expect(v.kind).toBe("disk");
    expect(v.reason).toContain("Disco quasi pieno");
    expect(v.memoryFirstCardExempt).toBe(false);
  });

  test("available memory above the floor is admitted without an exception", () => {
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
    // The global floor stays held; card-level eligibility belongs to the dispatcher.
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

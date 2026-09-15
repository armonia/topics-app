/**
 * The live fleet brake of the dispatcher: the slot budget as a credit on the
 * cores the rest of the machine leaves free, and the smoothing of the load of
 * others it reads. Split out of dispatch-capacity.test.ts when that file grew
 * past the 800-line threshold of check:bloat.
 * @covers KANBAN-07
 */
import { test, expect, describe } from "bun:test";
import { smoothedOther, newOtherLoadState, availableMemGB, fleetSlotBudget } from "./dispatch-capacity";
import { machineBudget } from "../../shared/board";

describe("fleetSlotBudget — il freno vivo è un credito, non una divisione", () => {
  // 12 cores = the Mac the defect was measured on: a share of 6 core-units.
  const su12 = (ourCoreUnits: number, running: number) => fleetSlotBudget({ cores: 12, ourCoreUnits, running });

  test("la quota è metà macchina, e a flotta ferma è tutta libera", () => {
    const b = su12(0, 0);
    expect(b.budgetCores).toBe(6);
    expect(b.freeCores).toBe(6);
    expect(b.slots).toBe(6);
  });

  test("IL DIFETTO CHE CHIUDE: un agente che costa una core-unità non abbassa il tetto", () => {
    // The invariant that stops the brake from measuring itself. With the old
    // count (`cores - load1`) every agent that started raised the load by two
    // or three points and shut the door on the next one, so the fleet settled
    // at ONE agent whatever the queue. Here the agent that starts raises
    // `running` by 1 and spends 1 of budget: the sum does not move.
    expect(su12(0, 0).slots).toBe(6);
    expect(su12(1, 1).slots).toBe(6);
    expect(su12(2, 2).slots).toBe(6);
    expect(su12(3, 3).slots).toBe(6);
  });

  test("the load of others, when NOT MEASURED, does not enter the count: the probe measures only us", () => {
    // The case of 12/08, real numbers: load 13 on 12 cores, but OUR fleet at
    // 0.75 cores. The old count gave 1 slot. Without a measure of WHO IS NOT
    // OURS the share stays the whole machine's: the load alone is not an input
    // of this function.
    expect(su12(0.75, 0).slots).toBe(5);
    expect(su12(0.75, 0).freeCores).toBeCloseTo(5.25, 5);
  });

  test("THE SHARE IS OF THE FREE: whoever is not ours comes first (14/09/2026)", () => {
    // Same machine, but now we know 8 of the 12 cores are somebody else's: the
    // fleet share is half of what is left, not half of the PC.
    const b = fleetSlotBudget({ cores: 12, ourCoreUnits: 0, running: 0, otherCoreUnits: 8 });
    expect(b.budgetCores).toBeCloseTo(2, 5);
    expect(b.slots).toBe(2);
    // And the old rule (share of the whole machine) would give three times as much.
    expect(su12(0, 0).budgetCores).toBe(6);
  });

  test("a fully busy machine leaves the floor, not zero", () => {
    const b = fleetSlotBudget({ cores: 12, ourCoreUnits: 0, running: 0, otherCoreUnits: 12 });
    expect(b.budgetCores).toBe(1);
    expect(b.slots).toBe(2);
  });

  test("the median smooths a one second spike, but not a load that lasts", () => {
    const state = newOtherLoadState();
    // The dispatcher tick is ~10 s, so five readings sit inside the 45 s
    // window. Three quiet readings, then a one second spike: the median does
    // not move, so the door does not shut over a cough of the machine.
    expect(smoothedOther(1, state, 0)).toBeCloseTo(1, 5);
    expect(smoothedOther(1, state, 10_000)).toBeCloseTo(1, 5);
    expect(smoothedOther(1, state, 20_000)).toBeCloseTo(1, 5);
    expect(smoothedOther(11, state, 30_000)).toBeCloseTo(1, 5);
    expect(smoothedOther(1, state, 40_000)).toBeCloseTo(1, 5);
    // A real load lasts: half a window above it and the median takes it.
    expect(smoothedOther(9, state, 50_000)).toBeCloseTo(1, 5);
    expect(smoothedOther(9, state, 60_000)).toBeCloseTo(9, 5);
    expect(smoothedOther(9, state, 70_000)).toBeCloseTo(9, 5);
    // Not measured does not enter the history and does not consume it.
    expect(smoothedOther(null, state, 80_000)).toBeNull();
    expect(state.samples).toHaveLength(5);
  });

  test("it widens only when the WHOLE window is under: half a quiet is not enough", () => {
    const state = newOtherLoadState();
    for (let i = 0; i < 5; i++) smoothedOther(9, state, i * 10_000);
    expect(state.held).toBeCloseTo(9, 5);
    // Two quiet readings: the machine MIGHT have freed up, but the load is
    // still inside the window. The ceiling does not reopen on a trough.
    expect(smoothedOther(1, state, 50_000)).toBeCloseTo(9, 5);
    expect(smoothedOther(1, state, 60_000)).toBeCloseTo(9, 5);
    // When the last high reading falls out of the window, the ceiling widens.
    smoothedOther(1, state, 70_000);
    smoothedOther(1, state, 80_000);
    expect(smoothedOther(1, state, 90_000)).toBeCloseTo(1, 5);
  });

  test("the window is TIME, not a count of readings: more readers do not shorten it", () => {
    // Three different readers (tick, panel, governor) sample at the same
    // instant. With a window counted in readings the history would already be
    // full of "now"; with a window of time, the reading from a minute ago is
    // out anyway and the one from twenty seconds ago is in anyway.
    const state = newOtherLoadState();
    smoothedOther(1, state, 0);
    for (const t of [80_000, 80_000, 80_000]) smoothedOther(9, state, t);
    expect(state.samples).toHaveLength(3);
    smoothedOther(9, state, 100_000);
    expect(state.samples.length).toBeGreaterThan(1);
  });

  test("HYSTERESIS: an alternating burst does NOT make the ceiling oscillate", () => {
    // The proof the card asks for: somebody else's CPU slams between 1 and 11
    // core-units at every tick. Without a band the usable ceiling would jump
    // between 8.8 and 0.8 at every breath of the machine; here it settles on
    // one number and stays there.
    const state = newOtherLoadState();
    const usable = (other: number, at: number) =>
      machineBudget(
        { cores: 12, totalMemGB: 32, ourCoreUnits: 0, otherCoreUnits: smoothedOther(other, state, at), ourMemGB: 0, availableMemGB: 16, running: 0 },
        0.8,
      ).usableCoreUnits;
    const readings: number[] = [];
    for (let i = 0; i < 12; i++) readings.push(usable(i % 2 ? 11 : 1, i * 10_000));
    // One single transition across twelve readings, then it stops moving.
    const jumps = readings.filter((v, i) => i > 0 && Math.abs(v - readings[i - 1]!) > 1e-9).length;
    expect(jumps).toBe(1);
    const steady = readings.slice(6);
    for (const v of steady) expect(v).toBeCloseTo(steady[0]!, 5);
  });

  test("agenti che compilano: il tetto scende underCeiling lo strutturale", () => {
    // Two agents at 2.5 cores each: 5 of the share spent, 1 left, so one more
    // place only. This is the brake that bites.
    expect(su12(5, 2).slots).toBe(3);
    // Three at 2 cores each: share used up, no new place.
    expect(su12(6, 3).slots).toBe(3);
  });

  test("un agente da solo non può chiudere la porta al secondo", () => {
    // The first one starts compiling and eats the whole share. Without a floor
    // the count would say "one", that is itself: the fleet would freeze on the
    // first to start, with the queue stuck behind it.
    expect(su12(12, 1).slots).toBe(2);
    expect(su12(6, 1).slots).toBe(2);
    // And a fleet of zero agents is not left without places either.
    expect(su12(99, 0).slots).toBe(2);
  });

  test("una misura assurda non sfonda in negativo", () => {
    expect(su12(-5, 0).freeCores).toBe(6);
    expect(su12(1e6, -3).slots).toBe(2);
  });
});

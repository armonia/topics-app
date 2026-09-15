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
  // 12 core = il Mac su cui il difetto è stato misurato: quota 6 core-unità.
  const su12 = (ourCoreUnits: number, running: number) => fleetSlotBudget({ cores: 12, ourCoreUnits, running });

  test("la quota è metà macchina, e a flotta ferma è tutta libera", () => {
    const b = su12(0, 0);
    expect(b.budgetCores).toBe(6);
    expect(b.freeCores).toBe(6);
    expect(b.slots).toBe(6);
  });

  test("IL DIFETTO CHE CHIUDE: un agente che costa una core-unità non abbassa il tetto", () => {
    // È l'invariante per cui il freno smette di misurare sé stesso. Col vecchio
    // conto (`cores - load1`) ogni agente che partiva alzava il load di due o
    // tre punti e chiudeva la porta al successivo, quindi la flotta si
    // stabilizzava a UN agente qualunque fosse la coda. Qui l'agente che parte
    // alza `running` di 1 e consuma 1 di budget: la somma non si muove.
    expect(su12(0, 0).slots).toBe(6);
    expect(su12(1, 1).slots).toBe(6);
    expect(su12(2, 2).slots).toBe(6);
    expect(su12(3, 3).slots).toBe(6);
  });

  test("the load of others, when NOT MEASURED, does not enter the count: the probe measures only us", () => {
    // Il caso del 12/08, numeri veri: load 13 su 12 core, ma la NOSTRA flotta a
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
    // Due agenti a 2,5 core l'uno: 5 di quota spesi, ne resta 1, quindi un
    // posto solo in più. Questo è il freno che morde.
    expect(su12(5, 2).slots).toBe(3);
    // Tre a 2 core l'uno: quota esaurita, nessun posto nuovo.
    expect(su12(6, 3).slots).toBe(3);
  });

  test("un agente da solo non può chiudere la porta al secondo", () => {
    // Il primo si mette a compilare e si mangia l'intera quota. Senza pavimento
    // il conto darebbe «uno», cioè lui: la flotta si congelerebbe sul primo che
    // è partito, con la coda ferma dietro.
    expect(su12(12, 1).slots).toBe(2);
    expect(su12(6, 1).slots).toBe(2);
    // E nemmeno la flotta a zero agenti resta senza posti.
    expect(su12(99, 0).slots).toBe(2);
  });

  test("una misura assurda non sfonda in negativo", () => {
    expect(su12(-5, 0).freeCores).toBe(6);
    expect(su12(1e6, -3).slots).toBe(2);
  });
});

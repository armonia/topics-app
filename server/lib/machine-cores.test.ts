/**
 * @covers CORES-01
 */
import { test, expect, describe } from "bun:test";
import os from "node:os";
import { machineCores } from "./machine-cores";

describe("machineCores — una macchina non perde core", () => {
  test("risponde con almeno un core, e con quelli veri se la macchina li dichiara", () => {
    const n = machineCores();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(n)).toBe(true);
    // Se la piattaforma sa contarli, il numero è quello e non un ripiego.
    const veri = os.availableParallelism?.() ?? 0;
    if (veri > 0) expect(n).toBe(veri);
  });

  test("IL DIFETTO: una lettura vuota non rimpicciolisce la macchina", () => {
    // È il caso misurato il 13/08: sotto la suite intera `os.cpus()` è tornato
    // vuoto e il conto del tetto ha creduto di stare su un host da un core,
    // proprio mentre la macchina era carica. Qui si riproduce la lettura rotta
    // e si controlla che il numero non scenda.
    const primo = machineCores();
    const veroCpus = os.cpus;
    const veroPar = os.availableParallelism;
    try {
      (os as { cpus: unknown }).cpus = () => [];
      (os as { availableParallelism?: unknown }).availableParallelism = () => { throw new Error("sysctl muto"); };
      expect(machineCores()).toBe(primo);
      expect(machineCores()).toBe(primo);
    } finally {
      (os as { cpus: unknown }).cpus = veroCpus;
      (os as { availableParallelism?: unknown }).availableParallelism = veroPar;
    }
    // E quando la lettura torna a funzionare, non è rimasto niente di rotto.
    expect(machineCores()).toBe(primo);
  });
});

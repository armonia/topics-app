/**
 * Il registro delle corse dei check: quello che rende una gamba corta sicura.
 *
 * La domanda a cui rispondono questi test è una sola, in quattro forme: se la
 * richiesta se ne va prima dei comandi, il lavoro non deve né raddoppiarsi né
 * perdersi.
 */
import { test, expect, describe } from "bun:test";
import { CHECKS_LEG_MS, clampLegMs, CHECKS_LEG_MS_MAX, createChecksGate } from "./checks-gate";

const differita = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));
const verde = { ok: true, comment: "verdi" };
const rosso = { ok: false, comment: "rossi" };

describe("createChecksGate", () => {
  test("la gamba scade prima della corsa: 'pending', e la corsa continua", async () => {
    const gate = createChecksGate();
    let giri = 0;
    const run = async () => { giri += 1; return differita(60, verde); };
    expect(await gate.leg("t1", { commit: "aa", legMs: 5, run })).toEqual({ pending: true });
    expect(gate.isRunning("t1")).toBe(true);
    expect(await gate.leg("t1", { commit: "aa", legMs: 500, run })).toEqual(verde);
    expect(giri).toBe(1); // la seconda gamba si è AGGANCIATA, non ha rilanciato
  });

  test("dieci gambe insieme, un giro solo di comandi", async () => {
    const gate = createChecksGate();
    let giri = 0;
    const run = async () => { giri += 1; return differita(30, rosso); };
    const gambe = await Promise.all(
      Array.from({ length: 10 }, () => gate.leg("t1", { commit: "aa", legMs: 500, run })),
    );
    expect(gambe).toEqual(Array.from({ length: 10 }, () => rosso));
    expect(giri).toBe(1);
  });

  test("il verdetto sopravvive alla gamba che l'ha chiesto", async () => {
    // Il caso vero: il socket cade proprio mentre i comandi finiscono. Chi torna
    // deve trovare l'esito, non dieci minuti di test da rifare.
    const gate = createChecksGate();
    let giri = 0;
    const run = async () => { giri += 1; return verde; };
    expect(await gate.leg("t1", { commit: "aa", legMs: 500, run })).toEqual(verde);
    expect(await gate.leg("t1", { commit: "aa", legMs: 500, run })).toEqual(verde);
    expect(giri).toBe(1);
    expect(gate.isRunning("t1")).toBe(false);
  });

  test("un commit nuovo è una consegna nuova: si rimisura", async () => {
    const gate = createChecksGate();
    let giri = 0;
    const run = async () => { giri += 1; return verde; };
    await gate.leg("t1", { commit: "aa", legMs: 500, run });
    await gate.leg("t1", { commit: "bb", legMs: 500, run });
    expect(giri).toBe(2);
  });

  test("il verdetto invecchia: oltre la ritenzione si rimisura", async () => {
    let ora = 1_000;
    const gate = createChecksGate({ retainMs: 100, now: () => ora });
    let giri = 0;
    const run = async () => { giri += 1; return verde; };
    await gate.leg("t1", { commit: "aa", legMs: 500, run });
    ora += 50;
    await gate.leg("t1", { commit: "aa", legMs: 500, run });
    expect(giri).toBe(1);
    ora += 500;
    await gate.leg("t1", { commit: "aa", legMs: 500, run });
    expect(giri).toBe(2);
  });

  test("una corsa che esplode non lascia la chiave avvelenata", async () => {
    const gate = createChecksGate();
    let giri = 0;
    const run = async () => { giri += 1; if (giri === 1) throw new Error("git sparito"); return verde; };
    // `null` = non ha misurato niente: chi chiama non deve scriverne un verdetto.
    expect(await gate.leg("t1", { commit: "aa", legMs: 500, run })).toBeNull();
    expect(gate.isRunning("t1")).toBe(false);
    expect(await gate.leg("t1", { commit: "aa", legMs: 500, run })).toEqual(verde);
  });

  test("un rigetto che nessuno sta aspettando non abbatte il processo", async () => {
    // La gamba se n'è già andata quando la corsa esplode: se la promise nel
    // registro rigettasse, sarebbe un unhandled rejection, cioè un server morto.
    const gate = createChecksGate();
    const run = async () => { await differita(20, null); throw new Error("boom"); };
    expect(await gate.leg("t1", { commit: "aa", legMs: 1, run })).toEqual({ pending: true });
    await differita(60, null);
    expect(gate.isRunning("t1")).toBe(false);
  });
});

describe("clampLegMs", () => {
  test("niente, o una sciocchezza, vale la gamba di serie", () => {
    expect(clampLegMs(undefined)).toBe(CHECKS_LEG_MS);
    expect(clampLegMs("25000")).toBe(CHECKS_LEG_MS);
    expect(clampLegMs(0)).toBe(CHECKS_LEG_MS);
    expect(clampLegMs(-1)).toBe(CHECKS_LEG_MS);
    expect(clampLegMs(Number.NaN)).toBe(CHECKS_LEG_MS);
  });

  test("nessuna gamba si avvicina ai 255s di Bun", () => {
    expect(clampLegMs(10 * 60_000)).toBe(CHECKS_LEG_MS_MAX);
    expect(CHECKS_LEG_MS_MAX).toBeLessThan(255_000);
    expect(clampLegMs(1_000)).toBe(1_000);
  });
});

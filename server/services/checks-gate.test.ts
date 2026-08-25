/**
 * Il registro delle corse dei check: quello che rende una gamba corta sicura.
 *
 * La domanda a cui rispondono questi test è una sola, in quattro forme: se la
 * richiesta se ne va prima dei comandi, il lavoro non deve né raddoppiarsi né
 * perdersi.
 *
 * I nuovi test coprono:
 *  · `runningCount()` - il contatore che il dispatcher usa per il freno
 *  · serializzazione - `maxConcurrent` limita le corse parallele
 *
 * @covers KANBAN-15
 */
import { test, expect, describe } from "bun:test";
import { CHECKS_LEG_MS, clampLegMs, CHECKS_LEG_MS_MAX, DEFAULT_MAX_CONCURRENT_CHECKS, createChecksGate } from "./checks-gate";

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

describe("runningCount — il contatore per il freno del dispatcher", () => {
  test("zero prima che cominci qualcosa", () => {
    const gate = createChecksGate();
    expect(gate.runningCount()).toBe(0);
  });

  test("sale a 1 mentre la corsa gira, torna a 0 dopo", async () => {
    const gate = createChecksGate();
    let resolve: (v: typeof verde) => void;
    const bloccata = new Promise<typeof verde>((r) => { resolve = r; });
    const run = async () => bloccata;
    const gamba = gate.leg("t1", { commit: "aa", legMs: 500, run });
    // Aspetta che la corsa sia partita davvero
    await differita(5, null);
    expect(gate.runningCount()).toBe(1);
    resolve!(verde);
    await gamba;
    expect(gate.runningCount()).toBe(0);
  });

  test("due chiavi diverse = due corse, contatore a 2", async () => {
    const gate = createChecksGate({ maxConcurrent: 2 });
    let r1: (v: typeof verde) => void, r2: (v: typeof verde) => void;
    const b1 = new Promise<typeof verde>((r) => { r1 = r; });
    const b2 = new Promise<typeof verde>((r) => { r2 = r; });
    const g1 = gate.leg("t1", { commit: "aa", legMs: 500, run: async () => b1 });
    const g2 = gate.leg("t2", { commit: "aa", legMs: 500, run: async () => b2 });
    await differita(5, null);
    expect(gate.runningCount()).toBe(2);
    r1!(verde);
    await g1;
    expect(gate.runningCount()).toBe(1);
    r2!(verde);
    await g2;
    expect(gate.runningCount()).toBe(0);
  });
});

describe("serializzazione — maxConcurrent limita le barre parallele", () => {
  test("il default e' 1 (serializzato)", () => {
    // Il default e' conservativo: una barra alla volta,
    // cosi' sei card che consegnano insieme non saturano la macchina.
    expect(DEFAULT_MAX_CONCURRENT_CHECKS).toBe(1);
  });

  test("con maxConcurrent=1 la seconda corsa aspetta la prima", async () => {
    const gate = createChecksGate({ maxConcurrent: 1 });
    const ordine: number[] = [];
    let sblocca: (() => void) | null = null;

    const run1 = async () => {
      await new Promise<void>((r) => { sblocca = r; });
      ordine.push(1);
      return verde;
    };
    const run2 = async () => {
      ordine.push(2);
      return rosso;
    };

    const g1 = gate.leg("t1", { commit: "aa", legMs: 500, run: run1 });
    const g2 = gate.leg("t2", { commit: "bb", legMs: 500, run: run2 });

    // Aspetta che la prima sia partita e la seconda sia in coda
    await differita(5, null);
    // Solo la prima sta girando
    expect(gate.runningCount()).toBe(1);
    // La seconda non ha ancora prodotto niente
    expect(ordine).toEqual([]);

    // Sblocca la prima
    sblocca!();
    await g1;
    // Ora la seconda dovrebbe essere partita
    await g2;

    // L'ordine: prima 1, poi 2 (serializzate)
    expect(ordine).toEqual([1, 2]);
  });

  test("con maxConcurrent=2 due corse girano insieme", async () => {
    const gate = createChecksGate({ maxConcurrent: 2 });
    const attive: Set<string> = new Set();
    let maxContemporanee = 0;

    const makeRun = (key: string) => async () => {
      attive.add(key);
      maxContemporanee = Math.max(maxContemporanee, attive.size);
      await differita(20, null);
      attive.delete(key);
      return verde;
    };

    await Promise.all([
      gate.leg("t1", { commit: "aa", legMs: 500, run: makeRun("t1") }),
      gate.leg("t2", { commit: "aa", legMs: 500, run: makeRun("t2") }),
      gate.leg("t3", { commit: "aa", legMs: 500, run: makeRun("t3") }),
    ]);

    // Con maxConcurrent=2, al massimo 2 corse girano insieme
    expect(maxContemporanee).toBe(2);
  });

  test("corsa accodata: isRunning=true anche prima che parta", async () => {
    // Una corsa accodata e' visibile come 'in corso' (pending) finche' finisce.
    const gate = createChecksGate({ maxConcurrent: 1 });
    let sblocca: (() => void) | null = null;
    const run1 = async () => {
      await new Promise<void>((r) => { sblocca = r; });
      return verde;
    };
    const run2 = async () => rosso;

    // Prima gamba: t1 parte e blocca
    const g1 = gate.leg("t1", { commit: "aa", legMs: 500, run: run1 });
    // Seconda gamba: t2 e' accodata (legMs brevissimo per non restare in attesa)
    gate.leg("t2", { commit: "bb", legMs: 1, run: run2 });
    await differita(5, null);
    // t2 e' accodata (non ancora partita), ma isRunning la vede come in corso
    expect(gate.isRunning("t2")).toBe(true);
    // runningCount conta solo chi STA girando davvero (non chi aspetta)
    expect(gate.runningCount()).toBe(1);
    // Sblocca t1: drain() fara' partire t2
    sblocca!();
    await g1;
    // Aspetta che t2 finisca (e' veloce, legMs lungo per catturare il verdetto)
    await gate.leg("t2", { commit: "bb", legMs: 500, run: run2 });
    expect(gate.isRunning("t2")).toBe(false);
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

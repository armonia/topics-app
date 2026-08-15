// La BARRA di `killProcessTree`: il segnale arriva a TUTTO l'albero, il SIGKILL
// ritardato non tiene sveglio l'event loop, e non colpisce mai un pid riciclato.
//
// I due difetti misurati (item M4):
//   · il `setTimeout` della grazia non era `unref`'d, quindi ogni chiamata
//     teneva vivo il loop per 5 secondi — anche `teardownAll()` allo shutdown,
//     che ne accende uno per anteprima;
//   · `getDescendantPids` leggeva una tabella dei processi in cache fino a 2
//     secondi, e un discendente nato dentro quella finestra non riceveva nessun
//     segnale. È esattamente la finestra in cui i discendenti nascono: si spegne
//     un dev server proprio mentre sta finendo di tirare su i suoi lavoratori.
import { test, expect, describe, afterEach } from "bun:test";
import {
  getDescendantPids,
  killProcessTreeWith,
  type KillTreeDeps,
} from "../../server/routes/processes";

const spawned: Array<{ kill: () => void }> = [];
afterEach(() => {
  for (const p of spawned.splice(0)) { try { p.kill(); } catch { /* già uscito */ } }
});

/** Un piccolo albero VERO: una shell con un figlio che dorme. */
function treeOfTwo(): { pid: number } {
  const proc = Bun.spawn(["sh", "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  spawned.push({ kill: () => proc.kill("SIGKILL") });
  return { pid: proc.pid };
}

describe("l'albero si legge FRESCO", () => {
  /**
   * Il rosso-prima: senza `fresh`, la tabella scaldata un istante prima non
   * conosce nemmeno il pid del padre, quindi l'albero è il solo pid passato e
   * il figlio non riceve niente.
   */
  test("un discendente nato dentro la finestra di cache si vede solo col giro fresco", async () => {
    // Scalda la cache PRIMA che l'albero esista.
    await getDescendantPids(process.pid);
    const { pid } = treeOfTwo();
    // Lascia nascere il figlio della shell, restando dentro i 2s di TTL.
    await Bun.sleep(300);

    const stale = await getDescendantPids(pid);
    const fresh = await getDescendantPids(pid, { fresh: true });
    expect(stale.size).toBe(1); // solo il pid chiesto: la tabella non lo conosce
    expect(fresh.size).toBeGreaterThan(1);
    expect(fresh.has(pid)).toBe(true);
  });
});

describe("il SIGKILL ritardato", () => {
  function deps(over: Partial<KillTreeDeps> = {}) {
    const signals: Array<[number, string]> = [];
    const timers: Array<{ ms: number; unrefd: boolean; fire: () => void }> = [];
    const d: KillTreeDeps = {
      descendants: async (pid) => new Set([pid, pid + 1, pid + 2]),
      startTimes: async (pids) => new Map(pids.map((p) => [p, `start-${p}`])),
      signal: (pid, sig) => { signals.push([pid, sig]); },
      defer: (fn, ms) => {
        const t = { ms, unrefd: false, fire: fn, unref() { t.unrefd = true; } };
        timers.push(t);
        return t;
      },
      ...over,
    };
    return { d, signals, timers };
  }

  test("il timer della grazia viene staccato dall'event loop", async () => {
    const { d, timers } = deps();
    await killProcessTreeWith(100, 5000, d);
    expect(timers.length).toBe(1);
    expect(timers[0].ms).toBe(5000);
    // Il difetto: senza questa riga il processo resta sveglio 5s per ogni kill,
    // e lo spegnimento ne accende uno per anteprima.
    expect(timers[0].unrefd).toBe(true);
  });

  test("SIGTERM a tutto l'albero subito", async () => {
    const { d, signals } = deps();
    await killProcessTreeWith(100, 5000, d);
    expect(signals).toEqual([[100, "SIGTERM"], [101, "SIGTERM"], [102, "SIGTERM"]]);
  });

  test("dopo la grazia il SIGKILL va solo a chi è la STESSA incarnazione", async () => {
    let round = 0;
    const { d, signals, timers } = deps({
      startTimes: async (pids) => {
        round++;
        // Al secondo giro 101 è un pid riciclato: stesso numero, altro processo.
        return new Map(pids.map((p) => [p, p === 101 && round > 1 ? "start-riciclato" : `start-${p}`]));
      },
    });
    await killProcessTreeWith(100, 5000, d);
    signals.length = 0;
    timers[0].fire();
    await Bun.sleep(0);
    expect(signals).toEqual([[100, "SIGKILL"], [102, "SIGKILL"]]);
  });

  test("un pid non valido non fa niente", async () => {
    const { d, signals, timers } = deps();
    await killProcessTreeWith(0, 5000, d);
    expect(signals).toEqual([]);
    expect(timers).toEqual([]);
  });

  test("se la lettura dell'albero fallisce si colpisce almeno il pid chiesto", async () => {
    const { d, signals } = deps({ descendants: async () => { throw new Error("ps giu'"); } });
    await killProcessTreeWith(100, 5000, d);
    expect(signals).toEqual([[100, "SIGTERM"]]);
  });
});

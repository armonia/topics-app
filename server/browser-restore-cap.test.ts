import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Il riscaldamento dei contesti browser all'avvio affamava il proprio riscossore.
 *
 * `restoreAllContexts` rilanciava eagerly i contesti Chromium piu' recenti a ogni
 * boot. Il reap dell'INTERO processo Chromium, poche righe sopra nello stesso
 * file, pretende `contexts.size === 0` per cinque minuti. Le due cose insieme non
 * possono convivere: se ogni avvio ne rimette otto e il reaper dei contesti fermi
 * scatta a trenta minuti, su una macchina dove il server si ricarica piu' spesso
 * di mezz'ora lo zero non arriva mai.
 *
 * Non e' una deduzione, e' quello che il log di produzione ha registrato in 254
 * avvii: 254 righe `8 restored`, 89 `Auto-closing inactive context`, e **zero**
 * `Reaping idle Chromium`. Prezzo misurato a riposo, app non toccata: 13
 * processi, 957 MB, 8,8% di un core in perpetuo.
 *
 * Questo test non prova il comportamento a runtime (servirebbe un Chromium
 * vero): prova il PATTO fra le due politiche, che e' la cosa che si e' rotta e
 * che si rompe di nuovo il giorno che qualcuno rialza il numero senza leggere il
 * reaper venti righe piu' su.
 */
const SRC = readFileSync(join(import.meta.dir, "browser-service.ts"), "utf8");

describe("il riscaldamento all'avvio non deve affamare il reap del browser", () => {
  test("il tetto e' zero di serie: pigro salvo richiesta esplicita", () => {
    const riga = /const RESTORE_MAX = ([^;]+);/.exec(SRC)?.[1] ?? "";
    expect(riga, "RESTORE_MAX non e' piu' dove il test lo cerca").not.toBe("");
    // La forma conta: un letterale > 0 rimetterebbe il difetto, e una manopola
    // il cui default non e' 0 pure.
    expect(riga).toContain("TOPICS_BROWSER_RESTORE_MAX");
    expect(riga).toMatch(/\?\?\s*0\b/);
  });

  test("la manopola esiste, cosi' la scelta si rifiuta con una misura e non con un'opinione", () => {
    expect(SRC).toContain("TOPICS_BROWSER_RESTORE_MAX");
  });

  test("il reap del browser dipende ancora da zero contesti, che e' il motivo del patto", () => {
    // Se un giorno questa condizione cambia, il vincolo qui sopra va ridiscusso
    // invece di restare per inerzia.
    expect(SRC).toContain("contexts.size === 0");
  });

  test("il ripristino pigro esiste davvero, altrimenti zero perderebbe qualcosa", () => {
    // Tutta la decisione poggia su questo: `createContext` ricarica storageState
    // e last-url da solo al primo uso. Senza, mettere 0 vorrebbe dire perdere
    // login e URL, e sarebbe un altro discorso.
    expect(SRC).toContain("createContext loads storageState");
  });
});

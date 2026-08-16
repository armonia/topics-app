/**
 * Chi pubblica deve sapere che sta pubblicando.
 *
 * Su questo repo main è spedito: un push fa scattare la CI e, se è verde,
 * l'auto-bump costruisce gli installer e li manda all'auto-updater di chiunque
 * abbia Topics aperta — in un quarto d'ora, senza altri gesti umani. È una
 * policy scelta apposta (2026-07-10) e il cancello CI→release del 16/08
 * (`af8efda5`) l'ha resa più forte.
 *
 * Il difetto non era la velocità: era che **nessuna schermata lo diceva**. Il
 * pannello elencava i commit che sarebbero usciti e offriva «Pubblica»; chi
 * premeva stava prendendo una decisione di pubblicazione senza che nulla gliela
 * nominasse.
 *
 * Questi casi difendono le due frasi, e la differenza fra loro: `land` è
 * LOCALE e non pubblica niente, `publish` sì. Confonderle è precisamente il
 * modo in cui qualcuno spedisce credendo di salvare.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RADICE = resolve(import.meta.dir, "../..");
const IT = readFileSync(resolve(RADICE, "client/src/lib/i18n.ts"), "utf8");
const EN = readFileSync(resolve(RADICE, "client/src/lib/i18n-en.ts"), "utf8");
const PANNELLO = readFileSync(
  resolve(RADICE, "client/src/components/Board/KanbanBoardPane.tsx"), "utf8",
);

/** Il valore di una chiave del catalogo, come stringa grezza. */
function valore(cat: string, chiave: string): string {
  const riga = cat.split("\n").find((l) => l.trimStart().startsWith(`'${chiave}':`));
  if (!riga) throw new Error(`chiave assente: ${chiave}`);
  return riga;
}

describe("pubblicare lo dice, prima del clic", () => {
  it("la conseguenza esiste in entrambe le lingue", () => {
    for (const cat of [IT, EN]) {
      expect(valore(cat, "board.publish.consequence")).toBeTruthy();
      expect(valore(cat, "board.publish.consequenceTitle")).toBeTruthy();
    }
  });

  it("nomina CHI la riceve, non solo che «esce»", () => {
    // «Pubblica il ramo» è vero e inutile: la parte che cambia una decisione è
    // che il risultato arriva a tutti gli utenti, da solo.
    expect(valore(IT, "board.publish.consequence").toLowerCase()).toContain("tutti");
    expect(valore(EN, "board.publish.consequence").toLowerCase()).toContain("everyone");
  });

  it("dice che il cancello è la CI, non un'approvazione umana", () => {
    // Chi legge deve sapere DOVE può ancora fermarsi: dopo il push, l'unico
    // punto che può bloccare è la CI.
    expect(valore(IT, "board.publish.consequenceTitle").toLowerCase()).toContain("ci");
    expect(valore(EN, "board.publish.consequenceTitle").toLowerCase()).toContain("ci");
  });

  it("il LAND invece dichiara che NON pubblica", () => {
    // È l'altra metà, e senza si crea il difetto opposto: due gesti che
    // sembrano lo stesso, uno dei quali spedisce.
    const it = valore(IT, "board.action.land.title").toLowerCase();
    expect(it).toContain("nessun push");
    expect(it).toContain("nessuna release");
    const en = valore(EN, "board.action.land.title").toLowerCase();
    expect(en).toContain("no push");
    expect(en).toContain("no release");
  });

  it("anche «landa comunque» dice che non pubblica", () => {
    // La variante per una card senza consegna cambia la parola sullo schermo,
    // quindi cambia anche il suo tooltip: se la promessa restasse indietro solo
    // qui, la porta meno sorvegliata sarebbe anche la meno spiegata.
    expect(valore(IT, "board.action.land.anyway.title").toLowerCase()).toContain("nessun push");
    expect(valore(EN, "board.action.land.anyway.title").toLowerCase()).toContain("no push");
  });

  it("la riga compare SOLO quando c'è qualcosa da pubblicare", () => {
    // Su una lista vuota sarebbe un avviso su un gesto che nessuno sta per
    // fare, cioè rumore che si impara a saltare — e il giorno che serve non lo
    // legge più nessuno.
    const i = PANNELLO.indexOf('data-testid="publish-consequence"');
    expect(i).toBeGreaterThan(0);
    const prima = PANNELLO.slice(Math.max(0, i - 400), i);
    expect(prima).toContain("pending.length > 0");
  });

  it("sta PRIMA dei bottoni, non dopo", () => {
    // Una conseguenza scritta sotto il gesto si legge dopo averlo fatto.
    expect(PANNELLO.indexOf('data-testid="publish-consequence"'))
      .toBeLessThan(PANNELLO.indexOf("doPublish(p)"));
  });
});

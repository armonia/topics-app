/**
 * OGNI IMPOSTAZIONE CHE IL SERVIZIO SA SCRIVERE DEVE ARRIVARGLI DALLA ROTTA.
 *
 * ── Il guasto, con la misura ────────────────────────────────────────────────
 * `PATCH /api/boards/:id/settings` non inoltrava un elenco a mano di campi: li
 * costruiva uno per uno, e quattro non c'erano. Il risultato non e' un errore —
 * e' peggio: la rotta risponde **200 con il valore vecchio**, quindi chi scrive
 * crede di aver scritto.
 *
 * Misurato il 2026-08-18 sul server vivo:
 *   PATCH {"dispatchPaused": true}  ->  200, e nella risposta `dispatchPaused: false`
 *
 * `dispatchPaused` ha un interruttore VERO nel pannello
 * (`client/src/components/Board/BoardSettingsPanel.tsx:84-85`, che chiama
 * `patch({ dispatchPaused })`): era un interruttore morto, e un interruttore
 * morto e' peggio di uno assente, perche' promette. `dispatchRetryCap` decide
 * quanti turni ha un agente prima che il sistema gli tolga la card di mano: era
 * bloccato a 2 e non alzabile da nessuna porta, ne' API ne' UI.
 *
 * ── Perche' legge il SORGENTE ───────────────────────────────────────────────
 * Un campo che la rotta non inoltra non produce nessuna risposta diversa da
 * osservare: la richiesta e' valida, l'esito e' 200, il corpo e' plausibile. Non
 * c'e' niente da interrogare a runtime — l'unica domanda a cui si puo'
 * rispondere e' «quali campi conosce il servizio, e quali ne nomina la rotta».
 * Stessa forma di `tests/unit/card-meta-row-completeness.test.ts`, e per la
 * stessa ragione: cio' che manca non lascia tracce.
 * @covers KANBAN-02
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = import.meta.dir;
const SERVIZIO = readFileSync(resolve(dir, "../services/tasks.ts"), "utf8");
const ROTTA = readFileSync(resolve(dir, "tasks.ts"), "utf8");

/** I campi che `updateBoardSettings` sa scrivere: `if (patch.X !== undefined)`. */
function campiDelServizio(): string[] {
  // L'IMPLEMENTAZIONE, non la dichiarazione dell'interfaccia: la stessa firma
  // compare due volte nel file e la prima non ha nessun corpo da leggere.
  const inizio = SERVIZIO.lastIndexOf("updateBoardSettings(projectId");
  expect(inizio, "updateBoardSettings e' cambiata di nome: aggiorna questo test").toBeGreaterThan(0);
  const corpo = SERVIZIO.slice(inizio, inizio + 12_000);
  const nomi = [...corpo.matchAll(/patch\.([A-Za-z0-9_]+)\s*!==\s*undefined/g)].map((m) => m[1]!);
  return [...new Set(nomi)];
}

/** I campi che la rotta nomina nella chiamata a `svc.updateBoardSettings`. */
function campiDellaRotta(): string[] {
  const inizio = ROTTA.indexOf("svc.updateBoardSettings(projectId, {");
  expect(inizio, "la chiamata della rotta e' cambiata di forma: aggiorna questo test").toBeGreaterThan(0);
  const corpo = ROTTA.slice(inizio, inizio + 6_000);
  const nomi = [...corpo.matchAll(/^\s{10,}([A-Za-z0-9_]+):/gm)].map((m) => m[1]!);
  return [...new Set(nomi)];
}

/**
 * `maxAgents` e' l'ECCEZIONE DICHIARATA, e la sua ragione sta scritta nella
 * rotta: il tetto degli agenti e' UNO per macchina e si scrive sulla riga `*`
 * (`PATCH /api/all-boards/settings`). Qui era accettato, salvato, rimostrato —
 * e non limitava niente. Un'esenzione senza ragione sarebbe un buco; questa la
 * porta scritta, e il test pretende che resti scritta.
 */
const ESENTI = new Map<string, string>([
  ["maxAgents", "il tetto e' uno per macchina: si scrive sulla riga '*', non per board"],
]);

describe("le impostazioni della board arrivano tutte dalla rotta", () => {
  test("i due elenchi non sono vuoti (guardia contro un verde a vuoto)", () => {
    // Se una delle due estrazioni smettesse di prendere, il confronto sotto
    // passerebbe misurando zero campi: il modo piu' comune in cui un cancello
    // smette di guardare senza che nessuno se ne accorga.
    expect(campiDelServizio().length).toBeGreaterThan(8);
    expect(campiDellaRotta().length).toBeGreaterThan(8);
  });

  test("ogni campo scrivibile dal servizio e' inoltrato dalla rotta", () => {
    const rotta = new Set(campiDellaRotta());
    const mancanti = campiDelServizio().filter((c) => !rotta.has(c) && !ESENTI.has(c));
    expect(
      mancanti,
      "Questi campi il servizio li sa scrivere ma la rotta non li passa: il PATCH risponde " +
        "200 con il valore vecchio, e chi scrive crede di aver scritto. Aggiungili alla " +
        "chiamata, oppure dichiarali in ESENTI con la ragione.",
    ).toEqual([]);
  });

  test("ogni esenzione porta scritta la sua ragione", () => {
    for (const [campo, ragione] of ESENTI) {
      expect(ragione.length, `l'esenzione di ${campo} non spiega niente`).toBeGreaterThan(30);
    }
  });
});

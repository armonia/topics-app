/**
 * IL CATALOGO DEI MODELLI È UNA GUARDIA, NON UN'ETICHETTA.
 *
 * `routes/chat.ts` confronta il modello richiesto con ciò che il provider
 * DICHIARA: quello che non compare nel catalogo viene scartato
 * (`Dropping stale model override`) e la sessione cade sul default. Quindi un
 * catalogo vecchio non è un dettaglio cosmetico — è un declassamento silenzioso
 * di ogni sessione che chiede il modello mancante.
 *
 * ── Il guasto che lo fa nascere (18-19/08/2026) ─────────────────────────────
 * Il catalogo si era fermato alla generazione 4-6. Il picker offriva
 * `claude-opus-5[1m]`, `long-window.ts` (17/08) sapeva già tradurre quel
 * suffisso nell'header beta che l'API vuole, e `agent-loop.ts` lo chiamava — ma
 * la guardia scartava l'override prima, perché l'id non era in lista. Risultato
 * misurato: ogni card della board girava su `claude-sonnet-4-6` mentre l'app
 * scriveva Opus 5 in due punti diversi dell'interfaccia.
 *
 * Nessuno dei test esistenti poteva vederlo: guardavano il loop, la finestra
 * lunga, la compattazione — cioè i pezzi che funzionavano. Mancava la domanda
 * «il catalogo e il codice che esegue sono d'accordo?».
 */
import { describe, expect, test } from "bun:test";
import { NativeProvider, DEFAULT_MODEL } from "./provider";
import { splitLongWindow } from "./long-window";

const provider = new NativeProvider({ type: "native" });

describe("catalogo dei modelli del runtime nativo", () => {
  test("il default è nel catalogo (se no la guardia scarta anche lui)", async () => {
    // Un default fuori catalogo è il caso peggiore: non c'è nessun override da
    // incolpare, e la sessione parte comunque su un id che il provider dice di
    // non conoscere.
    const models = await provider.listModels();
    expect(models).toContain(DEFAULT_MODEL);
  });

  test("la finestra lunga è RAGGIUNGIBILE: almeno un id `[1m]` è offerto", async () => {
    // È l'invariante che il guasto ha violato. `long-window.ts` esiste solo per
    // eseguire questi id: un catalogo senza nemmeno uno rende quel modulo
    // codice morto e la finestra da 1M irraggiungibile, in silenzio.
    const models = await provider.listModels();
    const lunghi = models.filter((m) => splitLongWindow(m).longWindow);
    expect(lunghi.length, "nessun modello a finestra lunga nel catalogo: long-window.ts sarebbe irraggiungibile").toBeGreaterThan(0);
  });

  test("ogni id `[1m]` ha anche la sua versione nuda", async () => {
    // Offrire solo la variante lunga costringerebbe la finestra da 1M anche a
    // chi non la vuole: il nome nudo è la scelta normale, quello col suffisso
    // è l'aggiunta.
    const models = await provider.listModels();
    for (const m of models) {
      const { model: nudo, longWindow } = splitLongWindow(m);
      if (longWindow) expect(models, `${m} è offerto senza ${nudo}`).toContain(nudo);
    }
  });

  test("nessun duplicato e nessun nome vuoto", async () => {
    const models = await provider.listModels();
    expect(new Set(models).size).toBe(models.length);
    for (const m of models) expect(m.trim().length).toBeGreaterThan(0);
  });

  test("IL PREDICATO MORDE: il catalogo di prima del guasto sarebbe stato bocciato", () => {
    // Senza questo caso, i controlli sopra resterebbero verdi anche se
    // `splitLongWindow` smettesse di riconoscere il suffisso, e nessuno lo
    // saprebbe finché non ricapita.
    const catalogoVecchio = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    const lunghi = catalogoVecchio.filter((m) => splitLongWindow(m).longWindow);
    expect(lunghi.length, "il catalogo 4-6 non aveva nessuna finestra lunga: è esattamente il caso da bocciare").toBe(0);
  });
});

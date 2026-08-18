import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = join(import.meta.dir, "..", "..", ".github", "workflows", "e2e-nightly.yml");
const src = readFileSync(WORKFLOW, "utf8");

/**
 * LA NIGHTLY SA DIRE ANCHE CHE È TORNATA VERDE.
 *
 * Il workflow apre una issue quando la suite cade, e nel corpo promette: «si
 * chiude da sola alla prima nightly verde». Il ramo che lo fa esiste — un passo
 * con `if: needs.e2e-full.result == 'success'` che commenta e chiude — ma
 * misurato il 17/08 su GitHub: **venti run, venti `failure`**. Quel passo
 * risulta `skipped` in ognuno, cioè NON È MAI STATO ESEGUITO in produzione.
 *
 * Un ramo mai eseguito è codice che nessuno ha visto funzionare, e qui vale
 * doppio: chi legge l'issue si fida di quella frase e smette di controllare a
 * mano. Se la chiusura automatica non funzionasse, la prima nightly verde
 * lascerebbe aperta una segnalazione falsa — e una segnalazione falsa aperta è
 * peggio di nessuna segnalazione, perché insegna a ignorare quelle vere.
 *
 * Non posso eseguire il ramo da qui (serve un run verde su CI). Quello che
 * posso presidiare è che le tre cose da cui dipende restino vere, e sono
 * esattamente le tre che una modifica distratta romperebbe in silenzio:
 *
 *   1. il passo esiste e scatta su `success`;
 *   2. cerca le issue con la STESSA etichetta con cui le apre — due etichette
 *      diverse e la chiusura non trova mai niente, senza errori;
 *   3. il job dell'esito gira SEMPRE (`if: always()`), o su verde non
 *      partirebbe affatto.
 *
 * Il test legge il sorgente del workflow: è l'unico posto in cui la domanda
 * «questo ramo è ancora coerente?» ha una risposta senza aspettare la notte.
 */
describe("la nightly sa chiudere ciò che ha aperto", () => {
  test("il passo che chiude la segnalazione esiste, e scatta sul verde", () => {
    expect(src).toContain("Chiudi la segnalazione se la nightly è tornata verde");
    expect(
      src.includes("if: needs.e2e-full.result == 'success'"),
      "il ramo verde non ha più la sua condizione: su una nightly verde non partirebbe",
    ).toBe(true);
    // E chiude davvero: commentare senza chiudere lascerebbe la issue aperta
    // con dentro scritto «chiudo», che è il peggio dei due mondi.
    expect(src).toContain('state: "closed"');
  });

  test("apre e chiude sulla STESSA etichetta", () => {
    // È il modo silenzioso in cui questo si rompe: si rinomina l'etichetta in
    // un punto solo, la chiusura non trova più niente, nessun errore, e la
    // segnalazione resta aperta per sempre.
    const etichette = [...src.matchAll(/labels:\s*(?:\[)?"([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(etichette.length, "nessuna etichetta trovata: il selettore è andato a vuoto").toBeGreaterThanOrEqual(2);
    expect(
      new Set(etichette).size,
      `apertura e chiusura usano etichette diverse (${[...new Set(etichette)].join(", ")}): la chiusura non troverebbe mai la issue`,
    ).toBe(1);
  });

  test("il job dell'esito gira anche quando la suite passa", () => {
    // `needs: e2e-full` + `if: always()`: senza `always()` il job dell'esito
    // verrebbe saltato quando la matrix fallisce, e senza `needs` valuterebbe
    // un esito che non c'è ancora. Servono entrambi.
    const esito = src.slice(src.indexOf("  esito:"));
    expect(esito).toContain("needs: e2e-full");
    expect(
      esito.includes("if: always()"),
      "senza `always()` il job dell'esito non parte quando la matrix fallisce, e la segnalazione non arriva",
    ).toBe(true);
    // E deve poter scrivere: senza questo permesso la chiamata fallisce a
    // metà, dopo che la suite ha già girato per quattordici minuti.
    expect(esito).toContain("issues: write");
  });

  test("la promessa scritta nella issue corrisponde al codice", () => {
    // Il corpo dice a chi legge «si chiude da sola alla prima nightly verde».
    // Se un giorno il ramo verde sparisse, quella frase diventerebbe una bugia
    // che nessuno verificherebbe: chi legge una issue non apre il workflow.
    const promette = src.includes("si chiude da sola alla prima nightly verde");
    const mantiene = src.includes("Chiudi la segnalazione se la nightly è tornata verde");
    expect(
      promette === mantiene,
      promette
        ? "la issue promette la chiusura automatica, ma il passo che la fa non c'è più"
        : "il passo di chiusura c'è ma la issue non lo dice: chi legge continuerà a chiudere a mano",
    ).toBe(true);
  });
});

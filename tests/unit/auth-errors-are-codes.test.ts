/**
 * Cricchetto: `/api/auth/**` risponde con CODICI, mai con prosa.
 *
 * ── PERCHÉ ──────────────────────────────────────────────────────────────────
 * Il campo `error` di quel router significava DUE cose a seconda della rotta.
 * Su `/api/auth/account/*` e sul rifiuto della licenza era un codice, che il
 * client traduce. Su `/api/auth/shares`, `/api/auth/share-links`,
 * `/api/auth/orgs*` e `/api/auth/devices/*` era una frase italiana — e
 * `ShareControl` e `DevicesSection` fanno `setErrore(body.error)`, cioè la
 * stampano tale e quale in mezzo a un'interfaccia inglese.
 *
 * Rimetterle è facilissimo: si scrive `json({ error: "serve un nome" }, 400)` e
 * compila. Questo test è la ragione per cui non torna in silenzio.
 *
 * ── PERCHÉ SCANSIONA IL SORGENTE ────────────────────────────────────────────
 * Perché la proprietà è «NESSUN letterale in prosa in questo file», e non «le
 * rotte che un test chiama rispondono con un codice». La seconda si verifica
 * una rotta alla volta e lascia scoperta la prossima; la prima è il file
 * intero, comprese le rotte che nessuno ha ancora coperto.
  * @covers AUTHERR-02
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CODICI_AUTH } from "../../shared/auth-codes";

const RADICE = join(import.meta.dir, "..", "..");
const SORGENTE = join(RADICE, "server", "routes", "auth.ts");

/** Ogni `error: "…"` letterale del router. */
function codiciEmessi(testo: string): string[] {
  return [...testo.matchAll(/error:\s*"([^"]*)"/g)].map((m) => m[1]);
}

describe("le rotte /api/auth/** rispondono con codici, non con frasi", () => {
  const testo = readFileSync(SORGENTE, "utf8");
  const emessi = codiciEmessi(testo);

  test("il file emette davvero dei rifiuti (il canale di osservazione esiste)", () => {
    // Senza questa riga, un `error:` rinominato o un file spostato renderebbe
    // la lista vuota e il test qui sotto verde per il motivo sbagliato.
    expect(emessi.length).toBeGreaterThan(20);
  });

  test("ogni rifiuto è un codice DICHIARATO in shared/auth-codes.ts", () => {
    const noti = new Set<string>(CODICI_AUTH);
    const sconosciuti = [...new Set(emessi)].filter((c) => !noti.has(c));
    expect(sconosciuti, "codici emessi ma non dichiarati (o prosa rimessa)").toEqual([]);
  });

  test("nessun rifiuto contiene spazi o accenti: sarebbe una frase", () => {
    // Il controllo indipendente dall'elenco: qualcuno potrebbe aggiungere la
    // frase ANCHE a `CODICI_AUTH` e passare il test qui sopra.
    const frasi = [...new Set(emessi)].filter((c) => /\s/.test(c) || /[À-ÿ]/.test(c));
    expect(frasi, "prosa nel campo `error`").toEqual([]);
  });

  test("un codice sconosciuto verrebbe VISTO (il controllo sa fallire)", () => {
    // La prova che le due asserzioni negative qui sopra non sono decorative:
    // le si esegue su un testo che contiene davvero una frase.
    const finto = 'return json({ error: "quella persona è stata revocata" }, 400);';
    const noti = new Set<string>(CODICI_AUTH);
    expect(codiciEmessi(finto).filter((c) => !noti.has(c))).toHaveLength(1);
    expect(codiciEmessi(finto).filter((c) => /\s/.test(c))).toHaveLength(1);
  });
});

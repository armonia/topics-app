/**
 * Il rifiuto per posti esauriti arriva fino a chi guarda.
 *
 * ── COSA PRESIDIA ───────────────────────────────────────────────────────────
 * Una stringa condivisa fra due file che non si conoscono. Il server risponde
 * `{"error":"no_seats_left"}`; l'interfaccia confronta quel valore per decidere
 * se mostrare la spiegazione buona («il piano gratuito ha un posto, ma puoi
 * comunque condividere autorizzando un dispositivo») o il messaggio generico.
 *
 * Rinominare il codice da una parte sola non rompe niente rumorosamente: il
 * confronto smette di corrispondere, il ramo cade sul generico, e l'utente
 * legge «non è riuscito» al posto di una spiegazione che gli direbbe cosa fare.
 * È la stessa forma del guasto che questo repo ha già avuto altrove — un
 * fallimento silenzioso nella direzione sicura, che nessuno vede finché non
 * serve.
 *
 * ── PERCHÉ NON UN TEST DI COMPONENTE ────────────────────────────────────────
 * Perché il difetto vero non è il rendering: era che la risposta non veniva
 * LETTA affatto (`await fetch(...)` e via, con il modulo che si chiudeva su un
 * 403). Quello lo prova il primo caso qui sotto. Il rendering completo resta
 * scoperto e va con la spec E2E delle impostazioni — detto qui invece che
 * lasciato credere coperto.
  * @covers LICENSE-06
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RADICE = join(import.meta.dir, "..", "..");
const ROTTE = readFileSync(join(RADICE, "server", "routes", "auth.ts"), "utf8");
const SEZIONE = readFileSync(
  join(RADICE, "client", "src", "components", "Settings", "IdentitySection.tsx"), "utf8",
);
// I due cataloghi vivono in due file da quando l'inglese si carica su richiesta
// (client/src/lib/i18n-en.ts, uscito dal bundle iniziale il 2026-08-15). Questo
// test conta le occorrenze di una chiave e si aspetta di trovarne DUE: leggere
// un file solo lo faceva cadere sul catalogo dimezzato, dicendo «manca
// l'inglese» quando l'inglese c'era, un file più in là.
const I18N = [
  readFileSync(join(RADICE, "client", "src", "lib", "i18n-it.ts"), "utf8"),
  readFileSync(join(RADICE, "client", "src", "lib", "i18n-en.ts"), "utf8"),
].join("\n");

describe("posti esauriti · il rifiuto arriva a chi guarda", () => {
  it("l'aggiunta LEGGE la risposta invece di ignorarla", () => {
    // Il difetto originale in una riga: `await fetch(...)` senza `r.ok`. Un 403
    // spariva, il modulo si chiudeva, e sembrava un guasto invece che un
    // limite.
    const i = SEZIONE.indexOf("const aggiungi = async");
    expect(i, "la funzione è stata rinominata: aggiorna questo test").toBeGreaterThan(-1);
    const corpo = SEZIONE.slice(i, SEZIONE.indexOf("\n  };", i));
    expect(corpo, "la risposta va raccolta in una variabile").toMatch(/const\s+\w+\s*=\s*await fetch\(/);
    expect(corpo, "e va guardata").toContain(".ok");
  });

  it("server e interfaccia usano LO STESSO codice", () => {
    // Il presidio vero: due file, una stringa. Rinominarla da una parte sola
    // fa cadere l'interfaccia sul messaggio generico, senza rumore.
    expect(ROTTE, "il server non emette più questo codice").toContain('"no_seats_left"');
    expect(SEZIONE, "l'interfaccia non riconosce più il codice del server").toContain("'no_seats_left'");
  });

  it("il messaggio esiste in entrambe le lingue e dice cosa si PUÒ fare", () => {
    const chiavi = [...I18N.matchAll(/'identity\.noSeats':\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(chiavi.length, "serve in italiano E in inglese").toBe(2);
    for (const testo of chiavi) {
      // Un rifiuto che dice solo «no» manda a cercare un problema che non c'è:
      // condividere con quella persona resta possibile sul piano gratuito, e la
      // frase deve nominarlo.
      expect(testo.toLowerCase()).toMatch(/dispositiv|device/);
    }
  });

  it("il rifiuto non butta via quello che avevi scritto", () => {
    // Chiudere il modulo su un errore costringe a riscrivere il nome per
    // riprovare, e fa sembrare che il gesto non sia stato registrato.
    const i = SEZIONE.indexOf("const aggiungi = async");
    const corpo = SEZIONE.slice(i, SEZIONE.indexOf("\n  };", i));
    const dopoRifiuto = corpo.slice(corpo.indexOf("setRifiuto("));
    expect(
      dopoRifiuto.slice(0, dopoRifiuto.indexOf("await ricarica") + 1 || undefined),
      "sul ramo del rifiuto il modulo deve restare aperto",
    ).not.toContain("setNuovo(null)");
  });
});

/**
 * Nessun documento manda l'utente a fare click destro → Apri.
 *
 * ── PERCHÉ È UN TEST E NON UNA RILETTURA ────────────────────────────────────
 * Perché quell'istruzione è stata giusta per anni, e ha smesso di esserlo senza
 * che niente si rompesse. Dal macOS Sequoia il bypass Control-click → Apri **non
 * esiste più**: chi lo segue non vede nessuna voce «Apri», riprova, conclude che
 * il download è corrotto, e se ne va. Un'istruzione morta non produce un errore
 * — produce un cliente che rinuncia, e non lo scopri mai.
 *
 * Era in TRE punti (`README.md`, `CONTRIBUTING.md`, e la nota già corretta in
 * `landing/public/agents.md`), il che è la forma tipica: una frase copiata
 * quando era vera, che nessuno rilegge quando smette di esserlo.
 *
 * ── COSA CONTROLLA, E COSA NO ───────────────────────────────────────────────
 * Solo i documenti rivolti a chi INSTALLA. Non tocca il resto del repo: «click
 * destro» è una frase legittima ovunque si parli di menu contestuali
 * dell'interfaccia, e vietarla in blocco renderebbe il presidio rumoroso e
 * quindi zittito.
  * @covers RELEASE-06
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RADICE = join(import.meta.dir, "..", "..");

/** I documenti che una persona legge PRIMA di riuscire ad aprire l'app. */
const DOCUMENTI = ["README.md", "CONTRIBUTING.md", "landing/public/agents.md"];

/** Le forme in cui l'istruzione morta si presenta, in entrambe le lingue. */
const MORTE = [
  /right[-\s]?click[^.\n]{0,40}\bopen\b/i,
  /control[-\s]?click[^.\n]{0,40}\bopen\b/i,
  /(tasto destro|click destro)[^.\n]{0,40}\bapri\b/i,
];

/** Il percorso che funziona davvero, e che deve restare scritto. */
const VIVA = /privacy\s*&?\s*security[\s\S]{0,120}open anyway/i;

describe("Gatekeeper · nessun documento manda a perdere tempo", () => {
  for (const doc of DOCUMENTI) {
    it(`${doc} non dice di fare click destro → Apri`, () => {
      const p = join(RADICE, doc);
      expect(existsSync(p), `${doc} non c'è più: aggiorna questo elenco`).toBe(true);
      const testo = readFileSync(p, "utf8");
      // La granularità è il PARAGRAFO, e ci sono voluti due tentativi.
      //
      // Con una finestra di caratteri attorno alla corrispondenza il test non
      // sapeva fallire: il README ha «no longer built or updated» in un
      // paragrafo vicino, e quel «no longer» zittiva un'istruzione morta
      // rimessa due righe sotto. Provato reintroducendola: restava verde.
      //
      // Con la singola RIGA era troppo stretto all'opposto: in `agents.md` la
      // frase che dichiara l'istruzione obsoleta va a capo in mezzo («is out of
      // / date»), quindi la negazione non stava sulla riga della corrispondenza
      // e il test accusava un documento corretto.
      //
      // Il paragrafo regge il testo mandato a capo senza farsi spegnere da
      // qualcosa che sta altrove.
      for (const paragrafo of testo.split(/\n\s*\n/)) {
        const nega = /no longer|out of date|non esiste|obsolet|wastes? their time/i.test(paragrafo);
        if (nega) continue;
        for (const forma of MORTE) {
          const trovato = forma.exec(paragrafo);
          expect(
            trovato ? `${doc}: «${trovato[0]}»` : null,
            "istruzione morta: dal macOS Sequoia quel menu non ha più «Apri»",
          ).toBeNull();
        }
      }
    });
  }

  it("il percorso che FUNZIONA è scritto dove serve", () => {
    // Il controllo positivo. Senza, questo file passerebbe anche cancellando
    // ogni spiegazione: nessuna istruzione morta, e nessuna istruzione.
    for (const doc of ["README.md", "CONTRIBUTING.md"]) {
      const testo = readFileSync(join(RADICE, doc), "utf8");
      expect(VIVA.test(testo), `${doc} non dice più come si apre davvero`).toBe(true);
    }
  });

  it("non si suggerisce di spegnere Gatekeeper per tutta la macchina", () => {
    // `spctl --master-disable` risolve un'app disarmando il sistema intero, ed è
    // una decisione che non si prende per conto di qualcun altro.
    for (const doc of DOCUMENTI) {
      const testo = readFileSync(join(RADICE, doc), "utf8");
      const m = /spctl\s+--master-disable/.exec(testo);
      const nega = m && /do not|non |mai /i.test(testo.slice(Math.max(0, m.index - 160), m.index));
      expect(m && !nega ? `${doc}` : null).toBeNull();
    }
  });
});

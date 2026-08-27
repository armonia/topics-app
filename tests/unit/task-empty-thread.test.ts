/**
 * Cosa dice il thread di un task che non ha ancora niente dentro.
 *
 * La regola che questi casi difendono: il vuoto dice a CHI TOCCA la mossa. È la
 * differenza fra una card che aspetta te e una che aspetta la macchina, e fino
 * al 16/08 dicevano la stessa identica cosa — «Nessun commento.» — cioè
 * constatavano un'assenza che si vedeva già da sola.
  * @covers EMPTYTHREAD-01
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emptyThreadKey } from "../../client/src/components/Board/emptyThread";

// I cataloghi si LEGGONO invece di importarli: l'italiano non esporta il suo
// oggetto (l'inglese si carica su richiesta da un file suo dal 2026-08-15), e
// un test che importasse solo quello che si puo' importare misurerebbe meta'
// del problema — cioe' proprio il caso «manca la traduzione» che deve prendere.
const RADICE = resolve(import.meta.dir, "../..");
const IT = readFileSync(resolve(RADICE, "client/src/lib/i18n-it.ts"), "utf8");
const EN = readFileSync(resolve(RADICE, "client/src/lib/i18n-en.ts"), "utf8");

describe("il vuoto di un task dice a chi tocca", () => {
  it("backlog aspetta l'umano, todo aspetta la macchina: NON la stessa frase", () => {
    // Il caso che giustifica tutto il resto. Se questi due collassassero sullo
    // stesso testo, la riga tornerebbe a non dire niente.
    expect(emptyThreadKey("backlog")).not.toBe(emptyThreadKey("todo"));
  });

  it("i quattro stati hanno quattro frasi distinte", () => {
    const chiavi = ["backlog", "todo", "in_progress", "done"].map(emptyThreadKey);
    expect(new Set(chiavi).size).toBe(4);
  });

  it("uno stato sconosciuto torna alla frase neutra, non ne inventa una", () => {
    // Inventare un invito per uno stato che non si conosce è peggio che
    // constatare: si prometterebbe un comportamento che nessuno ha scritto.
    expect(emptyThreadKey("review")).toBe("board.task.noComments");
    expect(emptyThreadKey("qualcosa-di-nuovo")).toBe("board.task.noComments");
  });

  it("ogni chiave esiste in ITALIANO e in INGLESE", () => {
    // Una chiave senza traduzione si vede come la chiave stessa, cioè
    // `board.task.emptyTodo` stampato in faccia all'utente: il modo più
    // silenzioso in cui una stringa nuova arriva rotta in produzione.
    for (const stato of ["backlog", "todo", "in_progress", "done", "review"]) {
      const k = emptyThreadKey(stato);
      expect(IT.includes(`'${k}':`), `manca in it: ${k}`).toBe(true);
      expect(EN.includes(`'${k}':`), `manca in en: ${k}`).toBe(true);
    }
  });

  it("il backlog nomina il gesto che sblocca, non solo lo stato", () => {
    // «Nessuno lo prenderà finché non lo sposti»: senza il gesto, la riga dice
    // dove sei e non come si va avanti.
    const k = emptyThreadKey("backlog");
    const riga = IT.split("\n").find((l) => l.includes(`'${k}':`))!;
    expect(riga.toLowerCase()).toContain("sposti");
  });
});

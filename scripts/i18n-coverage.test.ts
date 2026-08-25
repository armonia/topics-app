/**
 * Il numero che questo script produce serve a dire «quanto manca». Se sbaglia
 * per DIFETTO — non conta una stringa che l'utente legge — dichiara finita una
 * migrazione che non lo è, ed è l'unico errore che fa danno. I test guardano
 * quello, più i falsi positivi più tipici (classi CSS, chiavi, URL).
  * @covers GATE-03
 */
import { describe, test, expect } from "bun:test";
import { scanFile } from "./i18n-coverage";

describe("scanFile", () => {
  test("conta il testo che l'utente legge", () => {
    expect(scanFile('<span>Chiudi ora</span>')).toBe(1);
    expect(scanFile('<button>Dividi a destra</button>')).toBe(1);
  });

  test("conta gli attributi che si leggono o si sentono", () => {
    expect(scanFile('<input placeholder="Scrivi un messaggio" />')).toBe(1);
    expect(scanFile('<button title="Chiudi la pane" />')).toBe(1);
    expect(scanFile('<div aria-label="Barra laterale" />')).toBe(1);
  });

  test("NON conta le classi, le chiavi e gli URL", () => {
    // Sono i falsi positivi che gonfierebbero il numero fino a renderlo inutile.
    expect(scanFile('<div className="flex items-center gap-2" />')).toBe(0);
    expect(scanFile('<div data-testid="pane-tab-bar" />')).toBe(0);
    expect(scanFile('<a href="https://example.com/una/pagina" />')).toBe(0);
  });

  test("NON conta un'espressione: quella è già passata da qualcosa", () => {
    // `{tr('tab.menu.closeNow')}` è testo GIÀ tradotto: contarlo direbbe che
    // manca proprio ciò che è stato appena fatto.
    expect(scanFile("<span>{tr('tab.menu.closeNow')}</span>")).toBe(0);
  });

  test("NON conta simboli e unità", () => {
    expect(scanFile('<span>—</span>')).toBe(0);
    expect(scanFile('<span>42</span>')).toBe(0);
  });

  test("una frase minuscola con spazi viene contata lo stesso", () => {
    // Molte etichette dell'app sono minuscole: escluderle nasconderebbe lavoro.
    expect(scanFile('<span>nessuna sessione attiva</span>')).toBe(1);
  });

  test("un'etichetta di UNA PAROLA conta: sono tante, e sono vere", () => {
    // Una regola «senza spazi non conta» e stata provata e tolta subito:
    // nascondeva `Fissati`, `Rifiuta`, `Priorita`. Il conto scendeva di colpo e
    // sembrava progresso — era il contatore che smetteva di vedere.
    expect(scanFile('<span>Fissati</span>')).toBe(1);
    expect(scanFile('<button>Rifiuta</button>')).toBe(1);
  });

  test("NON conta i frammenti di codice finiti fra > e <", () => {
    // Un accesso a proprieta' o un pezzo di espressione JSX non sono frasi:
    // gonfiavano il conto di qualche decina.
    expect(scanFile('<span>React.Dispatch</span>')).toBe(0);
    expect(scanFile('<div>a && b || c</div>')).toBe(0);
  });
});

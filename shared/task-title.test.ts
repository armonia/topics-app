/**
 * Il titolo di una card, quando quello che arriva è un dettato.
 *
 * IL CASO VERO (card 235afe11, 20/08): il titolo era «Potremmo fare una roba
 * molto figa per poter assicurarci che il nostro browser…» — settantotto
 * caratteri di preambolo che finiscono a metà frase e non dicono di che cosa
 * parla la card. Segnalato: «dovrebbe mettere sempre qualcosa di utile per
 * comprendere».
 *
 * Questa funzione è la RETE, non la soluzione: il titolo vero lo ricava il
 * server col modello (`server/services/task-title.ts`). Qui si pretende solo
 * che, quando quello manca, il taglio non spezzi le parole.
 *
 * @covers KANBAN-22
 */
import { describe, expect, test } from "bun:test";
import { titoloDaTesto, accorcia, TITOLO_MAX } from "./task-title";

const DETTATO = "Potremmo fare una roba molto figa per poter assicurarci che il nostro browser ide sia effettivamente perfetto e interessante.\n- Omologare la cronologia delle tab di navigazione.";

describe("titoloDaTesto", () => {
  /**
   * IL CASO 235afe11 di per sé NON morde, e va detto invece di lasciarlo
   * sembrare una prova: in quel testo il carattere 77 cade per FORTUNA su uno
   * spazio, quindi anche il taglio vecchio dava «…il nostro browser…». La
   * prova che il taglio su parola serva sta nel test qui sotto, dove il
   * carattere 77 cade in mezzo a una parola.
   */
  test("IL CASO 235afe11: il titolo resta leggibile e sta nel limite", () => {
    const { title } = titoloDaTesto(DETTATO);
    expect(title.length).toBeLessThanOrEqual(TITOLO_MAX);
    const ultimaParola = title.replace(/…$/, "").trim().split(" ").pop()!;
    expect(DETTATO).toContain(ultimaParola);
  });

  /**
   * LA PROVA CHE MORDE. Qui il carattere 77 cade dentro «configurazione»: il
   * taglio vecchio produceva «…della configu…», questo lascia la parola
   * intera. È il difetto vero — un titolo mozzato a metà parola — e senza
   * questo caso i test passerebbero anche col taglio al carattere.
   */
  test("una parola a cavallo del limite non viene spezzata", () => {
    const s = "Sistemare il pannello delle impostazioni e la finestra della configurazione avanzata del browser";
    expect(s[77]).not.toBe(" "); // il taglio secco cadrebbe dentro una parola
    const { title } = titoloDaTesto(s);
    const ultimaParola = title.replace(/…$/, "").trim().split(" ").pop()!;
    // L'ASSERZIONE DEVE ESSERE FORTE, o passa per caso: la prima stesura
    // controllava `s.includes(parola + " ")`, e col taglio secco l'ultima
    // «parola» era «a» — che il testo contiene ovunque. Verde su un titolo
    // mozzato.
    //
    // Qui si pretende che la parola sia una PAROLA INTERA del testo: cioè che
    // compaia delimitata, non come coda di un'altra. Col taglio secco
    // («…configurazione a») fallisce, perché quella «a» è il moncone di
    // «avanzata».
    const parole = s.split(/\s+/);
    expect(parole).toContain(ultimaParola);
    // E non è un frammento di una parola più lunga rimasta a metà.
    expect(ultimaParola.length).toBeGreaterThan(2);
  });

  test("il testo intero non si perde mai: finisce nella descrizione", () => {
    const { description } = titoloDaTesto(DETTATO);
    expect(description).toContain("Omologare la cronologia");
    expect(description).toContain("Potremmo fare una roba");
  });

  test("un titolo già corto NON si tocca: è una scelta di chi ha scritto", () => {
    const { title, description } = titoloDaTesto("Sidebar: tre righe in fondo\ndettagli sotto");
    expect(title).toBe("Sidebar: tre righe in fondo");
    expect(description).toBe("dettagli sotto");
  });

  test("senza seconda riga la descrizione è null, non una stringa vuota", () => {
    expect(titoloDaTesto("Titolo corto").description).toBeNull();
  });
});

describe("accorcia", () => {
  test("preferisce una FRASE intera quando ce n'è una nel limite", () => {
    const s = "Rifare la fascia della sidebar. Poi servirà anche sistemare i separatori e gli spazi che non tornano.";
    // Il punto è a 31 caratteri: è lì che chi scrive ha chiuso un'unità di senso.
    expect(accorcia(s)).toBe("Rifare la fascia della sidebar.");
  });

  test("altrimenti taglia sull'ultimo spazio, con l'ellissi", () => {
    const s = "togliamo la linea sotto la topbar della kanban unifichiamo lo stile con il resto e sistemiamo gli spazi";
    const out = accorcia(s);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(TITOLO_MAX);
    // Nessuna parola spezzata: quella prima dell'ellissi esiste nel testo.
    expect(s).toContain(out.replace(/…$/, "").trim().split(" ").pop()!);
  });

  test("una riga senza spazi (un URL, un incolla) si taglia comunque", () => {
    const url = "https://example.com/" + "x".repeat(120);
    const out = accorcia(url);
    expect(out.length).toBeLessThanOrEqual(TITOLO_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  test("non accorcia ciò che è già dentro il limite", () => {
    const s = "Titolo che sta comodo";
    expect(accorcia(s)).toBe(s);
  });

  /**
   * Il taglio su frase non deve produrre un moncone: «Ok.» è una frase, ma non
   * è un titolo. Sotto la soglia utile si passa al taglio su parola.
   */
  test("una frase troppo corta non vince sul taglio su parola", () => {
    const s = "Ok. " + "parola ".repeat(30);
    const out = accorcia(s);
    expect(out).not.toBe("Ok.");
    expect(out.length).toBeGreaterThan(24);
  });
});

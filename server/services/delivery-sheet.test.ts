import { describe, test, expect } from "bun:test";
import { renderDeliverySheet, wrapText, deliverySheetPath } from "./delivery-sheet";
import { isDeliverySheetPath } from "../../shared/media-kind";

describe("wrapText", () => {
  test("manda a capo sulle parole e non supera il numero di righe", () => {
    const lines = wrapText("uno due tre quattro cinque sei sette otto nove dieci", 12, 2);
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(12);
  });

  test("segna il troncamento quando il testo non ci sta", () => {
    const lines = wrapText("uno due tre quattro cinque sei sette otto nove dieci", 12, 2);
    expect(lines[lines.length - 1]!.endsWith("…")).toBe(true);
  });

  test("un titolo corto resta una riga intera, senza troncamento", () => {
    expect(wrapText("titolo corto", 34, 3)).toEqual(["titolo corto"]);
  });

  test("una parola piu' lunga della riga viene tagliata, non sfora", () => {
    const lines = wrapText("supercalifragilistichespiralidoso", 10, 2);
    expect(lines[0]!.length).toBeLessThanOrEqual(10);
  });

  test("testo vuoto: nessuna riga", () => {
    expect(wrapText("   ", 20, 3)).toEqual([]);
  });
});

describe("path della scheda", () => {
  test("riconosce la propria scheda e non un'evidenza qualsiasi", () => {
    const p = deliverySheetPath("/tmp/media", "abc12345-0000");
    expect(p).toBe("/tmp/media/task-sheets/abc12345-0000.svg");
    expect(isDeliverySheetPath(p)).toBe(true);
    expect(isDeliverySheetPath("/tmp/media/task-previews/abc.png")).toBe(false);
    expect(isDeliverySheetPath("/tmp/media/diagramma.svg")).toBe(false);
    expect(isDeliverySheetPath(null)).toBe(false);
  });

  test("la media dir con lo slash finale non raddoppia lo slash", () => {
    expect(deliverySheetPath("/tmp/media/", "x")).toBe("/tmp/media/task-sheets/x.svg");
  });
});

describe("renderDeliverySheet", () => {
  const base = { taskId: "6db64c12-2e07-4fce", title: "Anteprima sempre presente" };

  test("con i numeri di consegna li mette in figura, col ramo", () => {
    const svg = renderDeliverySheet({
      ...base,
      branch: "topics/fading-falcon",
      filesChanged: 14,
      insertions: 1109,
      deletions: 5,
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("SCHEDA DI CONSEGNA");
    expect(svg).toContain(">14<");
    expect(svg).toContain("+1109");
    expect(svg).toContain("topics/fading-falcon");
    expect(svg).toContain("#6db64c12");
  });

  /**
   * IL RAMO SENZA RAMO non dichiara piu' un'assenza: prova a dire cosa e' stato
   * fatto. «Nessun codice consegnato. La consegna sta nel thread della card»
   * occupava il 60% della scheda per dire che l'informazione era altrove —
   * segnalato guardando una card in review («dovrebbe mettere sempre qualcosa
   * di utile per comprendere»). Quando una parola nel thread non c'e' davvero,
   * la scheda lo dice col MOTIVO, che e' un'altra cosa.
   */
  test("senza ramo non mostra uno zero muto ne' un rimando", () => {
    const svg = renderDeliverySheet({ ...base, branch: null, filesChanged: null });
    expect(svg).toContain("Nessun riassunto");
    expect(svg).not.toContain("La consegna sta nel thread");
    expect(svg).not.toContain("topics/");
  });

  test("il rapporto altezza/larghezza sta sotto la soglia della card (0.70)", () => {
    const svg = renderDeliverySheet(base);
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(m).not.toBeNull();
    expect(Number(m![2]) / Number(m![1])).toBeLessThanOrEqual(0.7);
  });

  test("il titolo e' XML-escapato: un & o un < non rompono il file", () => {
    const svg = renderDeliverySheet({ ...base, title: 'fix <img> & "quote"' });
    expect(svg).toContain("&lt;img&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).not.toContain("<img>");
  });

  test("i passi chiusi compaiono solo se ci sono sottotask", () => {
    expect(renderDeliverySheet({ ...base, subtasksTotal: 3, subtasksDone: 2 }))
      .toContain("Passi chiusi: 2 di 3");
    expect(renderDeliverySheet(base)).not.toContain("Passi chiusi");
  });

  test("al massimo tre etichette, il resto non entra in figura", () => {
    const svg = renderDeliverySheet({ ...base, labels: ["feature", "visibile", "chore", "misura"] });
    expect(svg).toContain("feature");
    expect(svg).not.toContain("misura");
  });
});

/**
 * IL RAMO SENZA CODICE deve dire cosa è stato fatto, non che non c'è nulla.
 *
 * Diceva «Nessun codice consegnato. La consegna sta nel thread della card»: il
 * 60% della larghezza della scheda per dichiarare un'ASSENZA e mandare a
 * leggere altrove. Segnalato guardando una card in review: «dovrebbe mettere
 * sempre qualcosa di utile per comprendere».
 *
 * Ora ci va l'ultima parola del thread — la stessa riga che la card disegna
 * sopra il titolo, così le due superfici non si contraddicono.
 */
describe("la scheda senza numeri di consegna", () => {
  const base = { taskId: "t1", title: "Cronologia tab unificata" };

  test("scrive COSA è stato fatto, quando il thread ha una parola", () => {
    const svg = renderDeliverySheet({
      ...base,
      summary: "Rifatta la fascia: via i separatori, chip che vanno a capo, amici resta anche a zero.",
    });
    expect(svg).toContain("Rifatta la fascia");
    // E non la vecchia dichiarazione di assenza.
    expect(svg).not.toContain("Nessun codice consegnato");
  });

  /**
   * Quando una parola non c'è DAVVERO (turno morto prima di commentare),
   * l'assenza È l'informazione: dirla è onesto, e dice anche il perché.
   */
  test("senza parole lo dice, col motivo", () => {
    const svg = renderDeliverySheet({ ...base });
    expect(svg).toContain("Nessun riassunto");
    expect(svg).toContain("prima che l");
  });

  test("un riassunto lungo si spezza in righe, non esce dalla scheda", () => {
    const svg = renderDeliverySheet({ ...base, summary: "parola ".repeat(80) });
    const righe = [...svg.matchAll(/class="b">([^<]+)</g)].map((m) => m[1]!);
    expect(righe.length).toBeLessThanOrEqual(3);
    for (const r of righe) expect(r.length).toBeLessThanOrEqual(70);
  });

  /** Il ramo CON codice non cambia: i numeri restano quelli che erano. */
  test("con i numeri di consegna la scheda resta com'era", () => {
    const svg = renderDeliverySheet({
      ...base, branch: "topics/x", filesChanged: 10, insertions: 525, deletions: 58,
      summary: "questo non deve comparire",
    });
    expect(svg).toContain("525");
    expect(svg).toContain("topics/x");
    expect(svg).not.toContain("questo non deve comparire");
  });
});

/**
 * IL RIASSUNTO ARRIVA DAL THREAD, cioè da testo che nessuno ha ripulito: lo
 * scrive un agente, e può contenere qualunque cosa. Un SVG rotto sulla card è
 * peggio di una card senza anteprima — non si vede l'errore, si vede il vuoto.
 */
describe("un riassunto ostile nella scheda", () => {
  test("tag e ampersand non rompono l'SVG", () => {
    const svg = renderDeliverySheet({
      taskId: "t1", title: "x",
      summary: 'Fatto <script>alert(1)</script> & "virgolette" con <tag>',
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  test("newline e spazi multipli si normalizzano invece di spezzare il layout", () => {
    const svg = renderDeliverySheet({ taskId: "t1", title: "x", summary: "riga1\n\n\nriga2\t\tcon   spazi" });
    const righe = [...svg.matchAll(/class="b">([^<]+)</g)].map((m) => m[1]!);
    expect(righe.length).toBeLessThanOrEqual(3);
    expect(righe[0]).toBe("riga1 riga2 con spazi");
  });
});

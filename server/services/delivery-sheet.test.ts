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

  test("senza ramo dice che non c'e' codice invece di mostrare uno zero muto", () => {
    const svg = renderDeliverySheet({ ...base, branch: null, filesChanged: null });
    expect(svg).toContain("Nessun codice consegnato");
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

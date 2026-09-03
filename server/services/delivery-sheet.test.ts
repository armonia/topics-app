/**
 * @covers KANBAN-61
 */
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

  /**
   * A DIFFSTAT IS NOT THE DELIVERY. The sheet showed three big figures - files,
   * insertions, deletions - plus the branch, and kept the summary for the
   * no-code case only. A reviewer does not ask which files changed: they ask
   * what the task is, where it stands and what they must decide. Reported twice
   * on the same day, the second time as: "not true things but USEFUL things, I
   * do not need git".
   */
  test("mostra cosa e' stato fatto, e NON il diffstat ne' il ramo", () => {
    const svg = renderDeliverySheet({
      ...base,
      branch: "topics/fading-falcon",
      filesChanged: 14,
      insertions: 1109,
      deletions: 5,
      summary: "Le tab di un progetto rientrano di un passo invece che di due.",
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("SCHEDA DI CONSEGNA");
    expect(svg).toContain("#6db64c12");
    expect(svg).toContain("rientrano di un passo");
    // The three figures and the branch are gone: they answered another question.
    expect(svg).not.toContain(">14<");
    expect(svg).not.toContain("+1109");
    expect(svg).not.toContain("file toccati");
    expect(svg).not.toContain("topics/fading-falcon");
  });

  /**
   * A BRANCH WITH NO COMMIT IS A STATE, NOT A ZERO. Measured on 2026-09-01 on
   * card 1c8fd103: two files changed in the worktree, no commit, and the sheet
   * wrote "0 file toccati" - which a reader takes as "nothing was done". The
   * same condition, said in words, is a decision waiting to be taken.
   */
  test("un ramo senza commit lo dice a parole, non con uno zero", () => {
    const svg = renderDeliverySheet({
      ...base,
      branch: "topics/stormy-teardrop",
      filesChanged: 0,
      summary: "Ho spostato le tab da depth 2 a depth 1.",
    });
    expect(svg).toContain("non e' consegnato");
    expect(svg).toContain("depth 2 a depth 1");
    expect(svg).not.toContain("file toccati");
  });

  /**
   * "NOTHING DONE" AND "DONE AND NOT COMMITTED" ARE TWO DIFFERENT CARDS, and
   * the sheet had one sentence for both. The number was not wrong, it was
   * INCOMPLETE: it counted commits, and a reader takes that for "produced
   * nothing". The cure differs in the two cases - one line asking for a commit
   * against a re-dispatch - so hiding the difference hides the decision.
   * Measured 2026-09-01 on card 1c8fd103: two files changed in the worktree,
   * zero commits, sheet at zero.
   */
  test("lavoro non committato: la scheda conta i file, non dice «niente»", () => {
    const sporca = renderDeliverySheet({
      ...base,
      branch: "topics/stormy-teardrop",
      filesChanged: 0,
      uncommittedFiles: 2,
      summary: "Ho spostato le tab da depth 2 a depth 1.",
    });
    expect(sporca).toContain("2 file modificati");
    expect(sporca).toContain("mai committati");
    // AND NOT the other case's sentence: the two exclude each other, or the
    // distinction would just be one more line to read.
    expect(sporca).not.toContain("Il ramo non porta ancora nessun commit");

    // THE CONTROL, without which the case above would pass with the
    // distinction switched off too: a clean worktree means the sheet says what
    // it has always said, and names no file at all.
    const pulita = renderDeliverySheet({
      ...base,
      branch: "topics/stormy-teardrop",
      filesChanged: 0,
      uncommittedFiles: 0,
      summary: "Ho spostato le tab da depth 2 a depth 1.",
    });
    expect(pulita).toContain("Il ramo non porta ancora nessun commit");
    expect(pulita).not.toContain("file modificati");

    // NOT MEASURED IS NOT CLEAN: with no probe the sheet does not invent a
    // zero, it falls back to the previous sentence.
    const ignota = renderDeliverySheet({
      ...base,
      branch: "topics/stormy-teardrop",
      filesChanged: 0,
      uncommittedFiles: null,
    });
    expect(ignota).toContain("Il ramo non porta ancora nessun commit");
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

  /**
   * THE BRANCH WITH CODE NOW SPEAKS TOO. The numbers used to win and the summary
   * was suppressed exactly where the work was: the sheet richest in substance
   * was the one that said the least about it.
   */
  test("con i numeri di consegna vince comunque il riassunto", () => {
    const svg = renderDeliverySheet({
      ...base, branch: "topics/x", filesChanged: 10, insertions: 525, deletions: 58,
      summary: "questo deve comparire",
    });
    expect(svg).toContain("questo deve comparire");
    expect(svg).not.toContain("525");
    expect(svg).not.toContain("topics/x");
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

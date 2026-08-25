/**
 * Le funzioni pure di `board-baseline.ts`, verificate contro valori calcolati a
 * mano. Servono a tenere onesta la parte statistica: una mediana sbagliata o un
 * intervallo che si stringe da solo cambierebbero la conclusione del confronto
 * board↔chat senza che nessuno se ne accorga.
 *
 *   bun test scripts/board-baseline.test.ts
  * @covers BENCH-02
 */
import { describe, expect, it } from "bun:test";
import {
  bracketCostUsd,
  cliffsDelta,
  comparabilityStamp,
  COST_STATS_MIN,
  costSummary,
  isComparablePost048,
  stats,
  THRESHOLDS,
} from "./board-baseline";

describe("stats", () => {
  it("quantili tipo 7 su una serie nota", () => {
    // 1..9: p25=3, mediana=5, p75=7 (interpolazione lineare, come R/numpy).
    const s = stats([9, 1, 8, 2, 7, 3, 6, 4, 5]);
    expect(s.n).toBe(9);
    expect(s.min).toBe(1);
    expect(s.max).toBe(9);
    expect(s.p25).toBe(3);
    expect(s.median).toBe(5);
    expect(s.p75).toBe(7);
    expect(s.iqr).toBe(4);
    expect(s.mean).toBe(5);
  });

  it("mediana su un campione pari = media dei due centrali", () => {
    expect(stats([1, 2, 3, 4]).median).toBe(2.5);
  });

  it("il campione vuoto non inventa numeri", () => {
    const s = stats([]);
    expect(s.n).toBe(0);
    expect(s.median).toBe(0);
    expect(s.medianCi95).toBeNull();
  });

  it("sotto gli 8 punti non produce un intervallo", () => {
    expect(stats([1, 2, 3, 4, 5, 6, 7]).medianCi95).toBeNull();
    expect(stats([1, 2, 3, 4, 5, 6, 7, 8]).medianCi95).not.toBeNull();
  });

  it("l'intervallo bootstrap è deterministico e contiene la mediana", () => {
    const xs = [10, 12, 13, 15, 18, 21, 25, 30, 44, 90];
    const a = stats(xs);
    const b = stats(xs);
    expect(a.medianCi95).toEqual(b.medianCi95);
    const ci = a.medianCi95;
    if (!ci) throw new Error("intervallo atteso");
    expect(ci[0]).toBeLessThanOrEqual(a.median);
    expect(ci[1]).toBeGreaterThanOrEqual(a.median);
  });

  it("un campione più disperso dà un intervallo più largo", () => {
    const tight = stats([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    const wide = stats([1, 40, 90, 103, 104, 105, 400, 900, 2000, 9000]);
    const t = tight.medianCi95;
    const w = wide.medianCi95;
    if (!t || !w) throw new Error("intervalli attesi");
    expect(w[1] - w[0]).toBeGreaterThan(t[1] - t[0]);
  });
});

describe("cliffsDelta", () => {
  it("separazione completa = ±1", () => {
    expect(cliffsDelta([10, 11, 12], [1, 2, 3]).delta).toBe(1);
    expect(cliffsDelta([1, 2, 3], [10, 11, 12]).delta).toBe(-1);
  });

  it("campioni identici = 0", () => {
    expect(cliffsDelta([1, 2, 3], [1, 2, 3]).delta).toBe(0);
  });

  it("campioni sovrapposti NON separano: l'intervallo contiene lo zero", () => {
    // Due estrazioni dalla stessa scala: dichiarare una differenza qui sarebbe
    // esattamente l'asserzione che non può fallire da cui ci si vuole difendere.
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const b = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const d = cliffsDelta(a, b);
    expect(d.separates).toBe(false);
    if (!d.ci95) throw new Error("intervallo atteso");
    expect(d.ci95[0]).toBeLessThanOrEqual(0);
    expect(d.ci95[1]).toBeGreaterThanOrEqual(0);
  });

  it("sotto gli 8 punti per lato non produce un intervallo, quindi non separa", () => {
    const d = cliffsDelta([10, 11, 12], [1, 2, 3]);
    expect(d.ci95).toBeNull();
    expect(d.separates).toBe(false);
  });
});

describe("soglie di classe", () => {
  it("sono costanti dichiarate, non terzili del campione", () => {
    // Il valore preciso conta meno del fatto che sia SCRITTO: un terzile
    // riempirebbe sempre i tre gruppi e non potrebbe falsificare nulla.
    expect(THRESHOLDS.files.smallMax).toBe(2);
    expect(THRESHOLDS.files.mediumMax).toBe(9);
    expect(THRESHOLDS.durationMs.smallMax).toBe(300_000);
    expect(THRESHOLDS.durationMs.mediumMax).toBe(1_800_000);
    expect(THRESHOLDS.turns.smallMax).toBe(2);
    expect(THRESHOLDS.turns.mediumMax).toBe(8);
  });
});

describe("soglia 048 — una definizione sola, e taglia sull'INIZIO", () => {
  const at = "2026-07-15T10:52:05.319Z";

  it("un task partito prima e chiuso dopo NON è comparabile", () => {
    const row = { in_progress_at: "2026-07-01T00:00:00.000Z", completed_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" };
    expect(isComparablePost048(row, at, "start")).toBe(false);
    // …ed è ESATTAMENTE il caso che la vecchia regola sulla fine faceva entrare.
    expect(isComparablePost048(row, at, "end")).toBe(true);
  });

  it("senza in_progress_at ripiega su completed_at, e senza soglia esclude", () => {
    expect(comparabilityStamp({ in_progress_at: null, completed_at: "2026-08-01T00:00:00.000Z" })).toBe("2026-08-01T00:00:00.000Z");
    expect(comparabilityStamp({ in_progress_at: null, completed_at: null })).toBeNull();
    expect(isComparablePost048({ in_progress_at: "2026-08-01T00:00:00.000Z" }, null)).toBe(false);
  });

  it("una stringa vuota non è una data: non passa per «maggiore della soglia»", () => {
    expect(comparabilityStamp({ in_progress_at: "", completed_at: "" })).toBeNull();
    expect(isComparablePost048({ in_progress_at: "", completed_at: "" }, at)).toBe(false);
  });
});

describe("dollari — sotto i 4 punti non esiste una distribuzione", () => {
  it("un solo valore NON produce mediana, quartili o IQR", () => {
    const c = costSummary([14.3163665]);
    expect(c.sufficient).toBe(false);
    expect(c.covered).toBe(1);
    // I campi che si leggerebbero come dispersione non ci sono proprio: non
    // esistono `median: 14.31` e `iqr: 0` da scambiare per una misura.
    expect("median" in c).toBe(false);
    expect("iqr" in c).toBe(false);
    if (!c.sufficient) expect(c.values).toEqual([14.3163665]);
  });

  it("zero valori resta zero valori, non uno zero", () => {
    const c = costSummary([]);
    expect(c.sufficient).toBe(false);
    expect(c.covered).toBe(0);
    if (!c.sufficient) expect(c.values).toEqual([]);
  });

  it(`da ${COST_STATS_MIN} punti in su la distribuzione c'è`, () => {
    const c = costSummary([4, 1, 3, 2]);
    expect(c.sufficient).toBe(true);
    if (c.sufficient) {
      expect(c.median).toBe(2.5);
      expect(c.covered).toBe(4);
      // n<8: l'intervallo bootstrap resta `null`, non si inventa.
      expect(c.medianCi95).toBeNull();
    }
  });
});

describe("forbice di prezzo — una sola aritmetica", () => {
  it("senza modello non prezza, invece di prezzare a zero", () => {
    expect(bracketCostUsd(null, 1_000_000, 1_000_000)).toBeNull();
  });

  it("il basso (tutto input) sta sotto l'alto (tutto output)", () => {
    const b = bracketCostUsd("claude-opus-4-8", 1_000_000, 0);
    expect(b).not.toBeNull();
    if (b) expect(b.lowUsd).toBeLessThan(b.highUsd);
  });
});

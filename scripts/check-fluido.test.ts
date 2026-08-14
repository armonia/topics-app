import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { budgetAggiornato, giudica, leggiMisura, type Baseline, type Misura } from "./check-fluido";

/**
 * IL CANCELLO PROVATO SUL CANCELLO.
 *
 * Un cancello che non si e' mai visto fallire non e' un cancello: passa, e
 * continua a passare, e nessuno sa se e' perche' va tutto bene o perche' non
 * guarda piu' niente. Il rosso vero, con il main thread bloccato davvero e la
 * misura presa dal banco, sta nel commit che ha introdotto questo file. Qui
 * sotto ci sono i casi che quel giro non puo' coprire senza un browser: le tre
 * metriche prese una per volta, la precedenza degli impedimenti sugli sfori, e
 * la misura stantia.
 *
 * Le fixture sono sintetiche APPOSTA. Il compito di `giudica` e' decidere, non
 * misurare: darle numeri veri la renderebbe verificabile solo quando c'e' un
 * Chromium, cioe' quasi mai.
 */

const BASELINE = JSON.parse(
  readFileSync(join(import.meta.dir, "fluido-baseline.json"), "utf8"),
) as Baseline;

/** Una misura pulita: e' quella vera del 2026-08-14, arrotondata. */
const PULITA: Misura = {
  measured_at: "2026-08-14T15:37:56.407Z",
  jank_injected_ms: 0,
  calibration_gap_ms: 8.3,
  median: { dropped_pct: 0, worst_gap_ms: 9.3, longtask_ms: 0, median_gap_ms: 8.3 },
  witness: { scroll_span_px: 4841, render_churn: 116 },
};

/** Ritocco a campi sparsi: le fixture dicono cosa CAMBIA, non tutto da capo. */
interface Ritocco {
  measured_at?: string;
  jank_injected_ms?: number;
  calibration_gap_ms?: number;
  median?: Partial<Misura["median"]>;
  witness?: Partial<Misura["witness"]>;
}

const con = (patch: Ritocco): Misura => ({
  ...PULITA,
  ...patch,
  median: { ...PULITA.median, ...(patch.median ?? {}) },
  witness: { ...PULITA.witness, ...(patch.witness ?? {}) },
});

describe("giudica", () => {
  it("da' verde sulla misura vera del repo", () => {
    const e = giudica(PULITA, BASELINE);
    expect(e.uscita).toBe(0);
    expect(e.sforati).toEqual([]);
    expect(e.impedimenti).toEqual([]);
  });

  it("stampa sempre tutte e tre le metriche, anche quando sono verdi", () => {
    // Una tabella che compare solo in caso di rosso costringe a rilanciare per
    // sapere quanto margine c'era, ed e' il margine a dire se ci si sta
    // avvicinando al muro.
    expect(giudica(PULITA, BASELINE).righe).toHaveLength(3);
  });

  // Le tre metriche una per volta: nessuna deve poter essere coperta da un'altra.
  // Se una di queste passasse in verde, quella metrica sarebbe decorazione.
  it("va rossa sui frame persi", () => {
    const e = giudica(con({ median: { dropped_pct: 10 } }), BASELINE);
    expect(e.uscita).toBe(1);
    expect(e.sforati).toHaveLength(1);
    expect(e.sforati[0]).toContain("dropped_pct");
  });

  it("va rossa sul buco peggiore anche con zero frame persi in media", () => {
    // Il caso che una sola percentuale non vedrebbe: uno strappo di 200 ms in
    // tre secondi si sente e pesa pochissimo sul totale.
    const e = giudica(con({ median: { dropped_pct: 0, worst_gap_ms: 200 } }), BASELINE);
    expect(e.uscita).toBe(1);
    expect(e.sforati[0]).toContain("worst_gap_ms");
  });

  it("va rossa sui long task", () => {
    const e = giudica(con({ median: { longtask_ms: 2240 } }), BASELINE);
    expect(e.uscita).toBe(1);
    expect(e.sforati[0]).toContain("longtask_ms");
  });

  it("il valore esattamente uguale al budget passa, quello appena sopra no", () => {
    expect(giudica(con({ median: { worst_gap_ms: 33.4 } }), BASELINE).uscita).toBe(0);
    expect(giudica(con({ median: { worst_gap_ms: 33.5 } }), BASELINE).uscita).toBe(1);
  });

  describe("misura non utilizzabile (uscita 2, non 1)", () => {
    it("macchina che non consegna frame nemmeno da ferma", () => {
      const e = giudica(con({ calibration_gap_ms: 45, median: { dropped_pct: 60 } }), BASELINE);
      expect(e.uscita).toBe(2);
      expect(e.impedimenti[0]).toContain("calibrazione");
    });

    it("banco che non ha scorso niente", () => {
      // Il modo tipico in cui una misura smette di misurare senza dirlo: zero
      // lavoro da' sempre zero frame persi, cioe' verde per sempre.
      const e = giudica(con({ witness: { scroll_span_px: 0, render_churn: 116 } }), BASELINE);
      expect(e.uscita).toBe(2);
      expect(e.impedimenti[0]).toContain("px");
    });

    it("virtualizzazione che non ha montato niente", () => {
      const e = giudica(con({ witness: { scroll_span_px: 4841, render_churn: 0 } }), BASELINE);
      expect(e.uscita).toBe(2);
      expect(e.impedimenti[0]).toContain("virtualizzazione");
    });

    it("misura piu' vecchia della run che avrebbe dovuto produrla", () => {
      // Senza questo, un banco caduto lascerebbe in giro il JSON del giro
      // precedente e il cancello darebbe il verde a codice mai provato.
      const e = giudica(PULITA, BASELINE, new Date("2026-08-14T16:00:00.000Z"));
      expect(e.uscita).toBe(2);
      expect(e.impedimenti[0]).toContain("PRIMA di questa run");
    });

    it("una misura fresca invece passa il controllo di freschezza", () => {
      expect(giudica(PULITA, BASELINE, new Date("2026-08-14T15:00:00.000Z")).uscita).toBe(0);
    });

    it("un impedimento vince su uno sforo: il rosso su una misura che non vale non e' un rosso", () => {
      const e = giudica(
        con({ median: { dropped_pct: 90 }, witness: { scroll_span_px: 0, render_churn: 0 } }),
        BASELINE,
      );
      expect(e.uscita).toBe(2);
      expect(e.sforati.length).toBeGreaterThan(0);
    });
  });
});

describe("budgetAggiornato", () => {
  it("non scrive mai un budget di zero da una misura di zero", () => {
    // Due metriche su tre misurano zero oggi: senza pavimento `--update-baseline`
    // scriverebbe una soglia che nessuna run puo' rispettare, e il cancello
    // diventerebbe rumore da spegnere.
    const b = budgetAggiornato(PULITA, BASELINE);
    expect(b.dropped_pct).toBe(2);
    expect(b.longtask_ms).toBe(50);
    expect(b.worst_gap_ms).toBe(33.4);
  });

  it("segue la misura quando la misura supera il pavimento", () => {
    const b = budgetAggiornato(con({ median: { worst_gap_ms: 40, longtask_ms: 120 } }), BASELINE);
    expect(b.worst_gap_ms).toBe(80);
    expect(b.longtask_ms).toBe(240);
  });
});

describe("leggiMisura", () => {
  it("rifiuta un JSON valido con la forma sbagliata", () => {
    // Un file di configurazione qualunque si legge senza errori: se passasse di
    // qui, il cancello leggerebbe `undefined <= budget` e direbbe verde.
    expect(() => leggiMisura(join(import.meta.dir, "fluido-baseline.json"))).toThrow(
      /forma di una misura/,
    );
  });
});

describe("i buchi che un avversario aveva trovato, chiusi", () => {
  // 1. IL METRO ERA FISSO A 60 Hz mentre il banco gira a 120: per un
  //    rallentamento UNIFORME i frame persi non erano una percentuale ma un
  //    gradino 0%/50%, quindi la chat poteva passare da 120 a 41 fps restando
  //    verde su tutte e tre le soglie. Qui si prova l'aritmetica del giudizio,
  //    non la sonda: col metro giusto (8,3 ms) lo stesso gap uniforme da' un
  //    numero che sfora, col metro sbagliato (16,7) da' zero.
  const persiCon = (gapMs: number, budgetMs: number) =>
    Math.max(0, Math.round(gapMs / budgetMs) - 1);

  it("il gradino a 60 Hz nasconde un rallentamento di tre volte", () => {
    expect(persiCon(24.9, 1000 / 60)).toBe(0);     // il buco: 41 fps, zero frame persi
    expect(persiCon(24.9, 8.3)).toBe(2);           // col metro vero, due frame persi su tre
  });

  it("e il metro non si allarga da solo su una macchina lenta", () => {
    // Una calibrazione peggiore del nominale non deve diventare un metro piu'
    // permissivo: li' si ricade sui 60 Hz, non si sale.
    const budget = (cal: number) => Math.min(cal > 0 ? cal : 1000 / 60, 1000 / 60);
    expect(budget(8.3)).toBeCloseTo(8.3, 2);
    expect(budget(33)).toBeCloseTo(1000 / 60, 2);
    expect(budget(0)).toBeCloseTo(1000 / 60, 2);
  });

  // 2. I TESTIMONI FALLIVANO APERTI: campo assente -> `undefined < 2000` false
  //    -> nessun impedimento -> verde.
  it("un testimone ASSENTE ferma il giudizio invece di lasciarlo passare", () => {
    const senza = { ...PULITA, witness: {} as never };
    const e = giudica(senza, BASELINE);
    expect(e.uscita).toBe(2);
    expect(e.impedimenti.join(" ")).toContain("scroll_span_px");
    expect(e.impedimenti.join(" ")).toContain("render_churn");
  });

  it("un testimone a ZERO resta un impedimento, come prima", () => {
    const zero = { ...PULITA, witness: { scroll_span_px: 0, render_churn: 0 } };
    expect(giudica(zero, BASELINE).uscita).toBe(2);
  });

  it("`measured_at` assente non spegne il controllo di freschezza", () => {
    const senzaData = { ...PULITA } as Record<string, unknown>;
    delete senzaData.measured_at;
    const e = giudica(senzaData as never, BASELINE, new Date());
    expect(e.uscita).toBe(2);
    expect(e.impedimenti.join(" ")).toContain("measured_at");
  });
});

/**
 * The context warning level: the percentage boundary is inclusive, and the
 * absolute-token threshold speaks on its own even when the window is barely used.
 *
 * @covers USAGE-09
 */
import { describe, expect, it } from "bun:test";
import {
  CONTEXT_CRITICAL_PERCENT,
  CONTEXT_CRITICAL_TOKENS,
  CONTEXT_WARN_PERCENT,
  CONTEXT_WARN_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  contextLevel,
} from "./context-thresholds";

describe("contextLevel — il confine è INCLUSIVO", () => {
  // Il bug che questo file esiste per non far tornare: il client scriveva
  // `percent > 70` mentre il server classifica `>= 70`. Esattamente sulla
  // soglia c'erano due verità sullo stesso numero, e l'anello mostrava quella
  // sbagliata. Ogni assert qui è sul valore ESATTO della soglia.
  it("alla soglia esatta è già warn, non ancora ok", () => {
    expect(contextLevel(CONTEXT_WARN_PERCENT - 1)).toBe("ok");
    expect(contextLevel(CONTEXT_WARN_PERCENT)).toBe("warn");
  });

  it("alla soglia critica esatta è già critical", () => {
    expect(contextLevel(CONTEXT_CRITICAL_PERCENT - 1)).toBe("warn");
    expect(contextLevel(CONTEXT_CRITICAL_PERCENT)).toBe("critical");
  });
});

describe("contextLevel — la soglia di COSTO vale anche a percentuale bassa", () => {
  // La seconda metà dello stesso bug: il client non conosceva affatto le soglie
  // in token assoluti, quindi un turno grosso su una finestra ampia era blu.
  it("un prompt oltre la soglia di warn è warn anche allo 0% di finestra", () => {
    expect(contextLevel(0, CONTEXT_WARN_TOKENS)).toBe("warn");
    expect(contextLevel(0, CONTEXT_WARN_TOKENS - 1)).toBe("ok");
  });

  it("380k su un milione: la capienza dice ok, il costo dice warn", () => {
    const percent = Math.round((380_000 / DEFAULT_CONTEXT_WINDOW) * 100); // 38
    expect(percent).toBeLessThan(CONTEXT_WARN_PERCENT);
    expect(contextLevel(percent, 380_000)).toBe("warn");
  });

  it("il livello è il PEGGIORE delle due scale, non l'ultima calcolata", () => {
    // capienza critical, costo ok → critical
    expect(contextLevel(95, 1_000)).toBe("critical");
    // capienza ok, costo critical → critical
    expect(contextLevel(5, CONTEXT_CRITICAL_TOKENS)).toBe("critical");
  });

  it("`used` assente non inventa un livello di costo", () => {
    expect(contextLevel(10)).toBe("ok");
    expect(contextLevel(10, Number.NaN)).toBe("ok");
  });
});

describe("DEFAULT_CONTEXT_WINDOW", () => {
  it("è 1M — lo standard della generazione, non una variante", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
  });
});

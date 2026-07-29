import { describe, test, expect } from "bun:test";
import { calculateCost, calculateCostWithCache, splitPromptTokens } from "./pricing";

// Regression coverage for the fuzzy-match fix: findPricing must not let a short
// model name match a LONGER key (e.g. "gpt-4o" → "gpt-4o-mini") and bill at the
// wrong rate. gpt-4o input = $2.50/M, gpt-4o-mini input = $0.15/M.
describe("calculateCost — model pricing resolution", () => {
  test("gpt-4o bills at the gpt-4o rate, not the longer gpt-4o-mini key", () => {
    expect(calculateCost("gpt-4o", 1_000_000, 0)).toBe(2.5);
  });

  test("gpt-4o-mini still resolves to its own (cheaper) rate", () => {
    expect(calculateCost("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(0.15, 6);
  });

  test("a longer/versioned name containing a known key still matches it", () => {
    expect(calculateCost("gpt-4o-2024-08-06", 1_000_000, 0)).toBe(2.5);
  });

  test("an unknown model is not billed (returns 0)", () => {
    expect(calculateCost("totally-unknown-model-xyz", 1_000_000, 1_000_000)).toBe(0);
  });
});

/**
 * La cache non si paga come input fresco. In un turno agentico lungo lo stesso
 * prompt viene riletto a ogni chiamata al modello, quindi l'aggregato di fine
 * turno è quasi tutto rilettura: tariffarla piena moltiplicava il costo per ~10.
 * I numeri qui sotto sono quelli veri di un turno osservato su topic:de521fd9
 * (5.908.766 token di prompt, 23.963 di output, mostrato a $90.43).
 */
describe("calculateCostWithCache — la cache paga la sua tariffa", () => {
  test("rilettura a 0.1x e scrittura a 1.25x rispetto all'input", () => {
    // 1M di sola rilettura su opus ($15/M) = $1.50, non $15.
    expect(calculateCostWithCache({ model: "claude-opus-5", freshInputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(1.5, 6);
    // 1M di sola scrittura = $18.75.
    expect(calculateCostWithCache({ model: "claude-opus-5", freshInputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000 })).toBeCloseTo(18.75, 6);
    // Senza cache si comporta esattamente come calculateCost.
    expect(calculateCostWithCache({ model: "claude-opus-5", freshInputTokens: 1_000_000, outputTokens: 0 }))
      .toBeCloseTo(calculateCost("claude-opus-5", 1_000_000, 0), 6);
  });

  test("il turno reale scende da ~$90 a ~$11 (la rilettura è quasi tutto il totale)", () => {
    const total = 5_908_766, cacheRead = 5_880_000, cacheCreation = 20_000, out = 23_963;
    const split = splitPromptTokens({ promptTokensTotal: total, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation });
    expect(split.fresh).toBe(total - cacheRead - cacheCreation);
    const before = calculateCost("claude-opus-5", total, out);
    const after = calculateCostWithCache({
      model: "claude-opus-5", freshInputTokens: split.fresh, outputTokens: out,
      cacheReadTokens: split.cacheRead, cacheCreationTokens: split.cacheCreation,
    });
    expect(before).toBeCloseTo(90.43, 1);
    // ~8 volte in meno. L'output resta a tariffa piena: è la sola quota che non cala.
    expect(after).toBeLessThan(12);
    expect(after).toBeGreaterThan(10);
    expect(before / after).toBeGreaterThan(7);
  });

  test("quote incoerenti dal provider non producono un credito", () => {
    // cacheRead > totale: `fresh` va a zero, mai negativo (un costo negativo
    // scalerebbe dal totale della sessione).
    const split = splitPromptTokens({ promptTokensTotal: 1000, cacheReadTokens: 99_999 });
    expect(split.fresh).toBe(0);
    expect(calculateCostWithCache({ model: "claude-opus-5", freshInputTokens: split.fresh, outputTokens: 0, cacheReadTokens: split.cacheRead })).toBeGreaterThan(0);
  });

  test("un modello sconosciuto resta non tariffato", () => {
    expect(calculateCostWithCache({ model: "modello-ignoto-xyz", freshInputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 5_000_000 })).toBe(0);
  });
});

describe("cache a un'ora — 2x, non 1.25x", () => {
  // Il commento che stava in pricing.ts diceva che la CLI aggrega le due durate e
  // che lo scarto è «ordini di grandezza» sotto. Falso su entrambi i conti:
  // l'usage porta `cache_creation` scorporato, e su una sessione reale il 100%
  // delle scritture (2,32M token) era a un'ora — 17,6% di conto in meno.
  const opus = { model: "claude-opus-5", freshInputTokens: 0, outputTokens: 0 };

  test("una scrittura a un'ora costa il doppio di una a cinque minuti", () => {
    const a5m = calculateCostWithCache({ ...opus, cacheCreationTokens: 1_000_000 });
    const a1h = calculateCostWithCache({ ...opus, cacheCreation1hTokens: 1_000_000 });
    expect(a1h / a5m).toBeCloseTo(2 / 1.25, 6);
  });

  test("le due quote si sommano invece di sovrascriversi", () => {
    const misto = calculateCostWithCache({
      ...opus,
      cacheCreationTokens: 400_000,
      cacheCreation1hTokens: 600_000,
    });
    const separate =
      calculateCostWithCache({ ...opus, cacheCreationTokens: 400_000 }) +
      calculateCostWithCache({ ...opus, cacheCreation1hTokens: 600_000 });
    expect(misto).toBeCloseTo(separate, 10);
  });

  test("chi passa solo il totale ottiene il comportamento di prima", () => {
    // Retrocompatibilità: nessun chiamante esistente cambia costo.
    expect(calculateCostWithCache({ ...opus, cacheCreationTokens: 1_000_000 }))
      .toBeCloseTo((1_000_000 * 15 * 1.25) / 1_000_000, 10);
  });

  test("sui numeri veri della sessione misurata: +17,6% sul solo write", () => {
    const write = 2_316_086; // tutto a un'ora, misurato
    const sbagliato = calculateCostWithCache({ ...opus, cacheCreationTokens: write });
    const giusto = calculateCostWithCache({ ...opus, cacheCreation1hTokens: write });
    expect(giusto - sbagliato).toBeCloseTo((write * 15 * 0.75) / 1_000_000, 6);
    expect(giusto).toBeGreaterThan(sbagliato);
  });
});

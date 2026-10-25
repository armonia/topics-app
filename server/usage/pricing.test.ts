/**
 * Model pricing: the table, the fallbacks, and the cache rates.
 *
 * @covers USAGE-01, USAGE-02
 */
import { describe, test, expect } from "bun:test";
import { calculateCost, calculateCostWithCache, callsCostUsd, splitPromptTokens, type PricedCall } from "./pricing";
import { modelPrice, ownModelPrice } from "../../shared/model-pricing";
import { NativeProvider, DEFAULT_MODEL } from "../providers/native/provider";
import { engineModelOf } from "../lib/native-subagents";

// Il prezzo di input del modello di riferimento dei test. Vive qui come
// COSTANTE, non ricalcolato da `calculateCost`: un test che deriva l'atteso
// dalla stessa funzione che verifica non può accorgersi di un prezzo sbagliato —
// ed è esattamente com'è passato inosservato che ogni Opus veniva tariffato
// 15$/M invece di 5$/M, cioè il triplo, per mesi.
const OPUS_IN = 5;   // $/1M token di input  — claude-opus-5
const OPUS_OUT = 25; // $/1M token di output — claude-opus-5

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

  test("i modelli IN USO hanno un prezzo proprio, non il ripiego di famiglia", () => {
    // Il difetto che questo test blocca: la tabella conteneva solo modelli
    // ritirati, quindi ogni id reale cadeva nel ripiego — che puntava al modello
    // piu' VECCHIO della famiglia. Un Opus da 5$/25$ veniva contato 15$/75$.
    expect(calculateCost("claude-opus-5", 1_000_000, 0)).toBeCloseTo(OPUS_IN, 6);
    expect(calculateCost("claude-opus-5", 0, 1_000_000)).toBeCloseTo(OPUS_OUT, 6);
    expect(calculateCost("claude-opus-4-8", 1_000_000, 0)).toBeCloseTo(5, 6);
    // Sonnet 5's $2/$10 launch price became the standard one; the move to
    // $3/$15 announced for September was cancelled.
    expect(calculateCost("claude-sonnet-5", 1_000_000, 0)).toBeCloseTo(2, 6);
    expect(calculateCost("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(1, 6);
    expect(calculateCost("claude-fable-5", 1_000_000, 0)).toBeCloseTo(10, 6);
  });

  test("il suffisso di finestra non fa perdere il prezzo esatto", () => {
    // `claude-opus-5[1m]` e' l'id che la CLI riporta davvero. La finestra non
    // cambia la tariffa: senza normalizzarlo il match esatto falliva e si finiva
    // nel ripiego.
    expect(calculateCost("claude-opus-5[1m]", 1_000_000, 0)).toBeCloseTo(OPUS_IN, 6);
  });

  test("il ripiego di famiglia punta al modello CORRENTE", () => {
    // Un Opus futuro non ancora in tabella non deve essere tariffato come uno
    // ritirato: sbagliare per eccesso e' il modo in cui i costi mostrati sono
    // diventati il triplo del vero.
    expect(calculateCost("claude-opus-99-inesistente", 1_000_000, 0)).toBeCloseTo(4, 6);
    expect(calculateCost("claude-sonnet-99-inesistente", 1_000_000, 0)).toBeCloseTo(2, 6);
    expect(calculateCost("claude-haiku-99-inesistente", 50_000, 0)).toBeCloseTo(0.005, 9);
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
    // 1M di sola rilettura su opus ($5/M) = $0.50, non $5.
    expect(calculateCostWithCache({ model: "claude-opus-5", freshInputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(OPUS_IN * 0.1, 6);
    // 1M di sola scrittura a 5 minuti = 1.25x l'input.
    expect(calculateCostWithCache({ model: "claude-opus-5", freshInputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000 })).toBeCloseTo(OPUS_IN * 1.25, 6);
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
    // I due valori assoluti citati nel titolo ($90 → $11) erano al prezzo
    // SBAGLIATO di allora (15$/M): al prezzo vero sono un terzo. Quello che il
    // test difende non e' la cifra, e' il RAPPORTO — la rilettura e' quasi tutto
    // il totale, quindi tariffarla piena moltiplicava il conto per circa otto.
    expect(before).toBeCloseTo((total * OPUS_IN + out * OPUS_OUT) / 1_000_000, 1);
    expect(before / after).toBeGreaterThan(7);
    expect(after).toBeLessThan(before / 7);
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
      .toBeCloseTo((1_000_000 * OPUS_IN * 1.25) / 1_000_000, 10);
  });

  test("sui numeri veri della sessione misurata: +17,6% sul solo write", () => {
    const write = 2_316_086; // tutto a un'ora, misurato
    const sbagliato = calculateCostWithCache({ ...opus, cacheCreationTokens: write });
    const giusto = calculateCostWithCache({ ...opus, cacheCreation1hTokens: write });
    expect(giusto - sbagliato).toBeCloseTo((write * OPUS_IN * 0.75) / 1_000_000, 6);
    expect(giusto).toBeGreaterThan(sbagliato);
  });
});

/**
 * The 5.5 generation. Prices from platform.claude.com/docs/en/about-claude/pricing
 * (read 24/10/2026), written here as constants for the same reason as OPUS_IN:
 * an expected value derived from the table under test cannot catch a wrong row.
 */
describe("5.5 generation: own rows and per-model cache-read rate", () => {
  const readOnly = (model: string) => calculateCostWithCache({ model, freshInputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });

  test("Opus, Sonnet and Haiku 5.5 have their own input and output prices", () => {
    expect(calculateCost("claude-opus-5-5", 1_000_000, 1_000_000)).toBeCloseTo(4 + 20, 6);
    expect(calculateCost("claude-opus-5-5[1m]", 1_000_000, 1_000_000)).toBeCloseTo(4 + 20, 6);
    expect(calculateCost("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBeCloseTo(2 + 10, 6);
    expect(calculateCost("claude-haiku-5-5", 50_000, 1_000_000)).toBeCloseTo(0.005 + 0.5, 6);
  });

  test("a cache read costs what THAT model charges, not a flat tenth", () => {
    expect(readOnly("claude-opus-5-5")).toBeCloseTo(0.2, 6);    // 0.05x of $4
    expect(readOnly("claude-sonnet-5-5")).toBeCloseTo(0.1, 6);  // 0.05x of $2
    expect(readOnly("claude-fable-5-1")).toBeCloseTo(0.25, 6);  // 0.025x of $10
    expect(readOnly("claude-fable-5")).toBeCloseTo(1, 6);       // 0.1x of $10
    expect(readOnly("claude-opus-5")).toBeCloseTo(0.5, 6);      // 0.1x of $5
  });

  test("turn 4 of the finance chat: $6.04 at the real prices, not $13.27", () => {
    // Real row (messages 3132a726, topic:f55fc83a, 24/10): 98 calls on Opus 5.5.
    const prompt = 23_010_793, cacheRead = 22_889_547, write5m = 120_854, out = 42_651;
    const usd = calculateCostWithCache({
      model: "claude-opus-5-5",
      freshInputTokens: prompt - cacheRead - write5m,
      outputTokens: out,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: write5m,
    });
    expect(usd).toBeCloseTo(6.04, 2);
  });

  test("Haiku 5.5: one request over 100k tokens of prompt pays the long card on every token", () => {
    // One 150k request: every token, cache reads included, at $0.50/$2.50.
    const one = calculateCostWithCache({ model: "claude-haiku-5-5", freshInputTokens: 50_000, cacheReadTokens: 100_000, outputTokens: 1_000_000 });
    expect(one).toBeCloseTo((50_000 * 0.5 + 100_000 * 0.05 + 1_000_000 * 2.5) / 1_000_000, 9);
    // Exactly at the threshold is still the first card.
    expect(calculateCost("claude-haiku-5-5", 100_000, 0)).toBeCloseTo(0.01, 9);
  });
});

/**
 * Haiku 5.5 chooses its rate card per REQUEST. The calls below are not uniform,
 * so neither the turn total nor the turn average lands on the right card: the
 * only right price is each call on its own, summed. Expected values written by
 * hand from the official cards ($0.10/$0.50, and $0.50/$2.50 over 100k).
 */
describe("a turn of Haiku 5.5 calls is priced call by call", () => {
  /** A call with `prompt` tokens of prompt, `fresh` of them not from the cache. */
  const call = (prompt: number, fresh: number, output: number): PricedCall => ({
    inputTokens: prompt, outputTokens: output, cacheRead: prompt - fresh, cacheCreation: 0, cacheCreation1h: 0, model: "claude-haiku-5-5",
  });

  test("60k, 80k, 120k, 140k: two calls on each card", () => {
    const calls = [call(60_000, 2_000, 500), call(80_000, 2_000, 500), call(120_000, 2_000, 500), call(140_000, 2_000, 500)];
    const cheap = (read: number) => (2_000 * 0.1 + read * 0.01 + 500 * 0.5) / 1_000_000;
    const long = (read: number) => (2_000 * 0.5 + read * 0.05 + 500 * 2.5) / 1_000_000;
    const expected = cheap(58_000) + cheap(78_000) + long(118_000) + long(138_000);
    expect(callsCostUsd(calls, "unknown")).toBeCloseTo(expected, 12);
    expect(expected).toBeCloseTo(0.01956, 9);
  });

  test("40k x3 and 300k: only the big call pays the long card", () => {
    const calls = [call(40_000, 40_000, 10_000), call(40_000, 40_000, 10_000), call(40_000, 40_000, 10_000), call(300_000, 300_000, 10_000)];
    const expected = 3 * (40_000 * 0.1 + 10_000 * 0.5) / 1_000_000 + (300_000 * 0.5 + 10_000 * 2.5) / 1_000_000;
    expect(callsCostUsd(calls, "unknown")).toBeCloseTo(expected, 12);
    expect(expected).toBeCloseTo(0.202, 9);
  });

  test("a call without its model is priced at the fallback model", () => {
    const anonymous: PricedCall = { inputTokens: 1_000_000, outputTokens: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 };
    expect(callsCostUsd([anonymous], "claude-sonnet-5-5")).toBeCloseTo(2, 9);
    expect(callsCostUsd([{ ...anonymous, model: "claude-opus-5-5" }], "claude-sonnet-5-5")).toBeCloseTo(4, 9);
  });

  test("the shares of a call are billed for what they are: 1h writes at 2x, 5m at 1.25x", () => {
    // 1M of prompt: 600k written, 400k of which with the one-hour TTL.
    const c: PricedCall = { inputTokens: 1_000_000, outputTokens: 0, cacheRead: 0, cacheCreation: 600_000, cacheCreation1h: 400_000, model: "claude-opus-5-5" };
    expect(callsCostUsd([c], "unknown")).toBeCloseTo(400_000 * 4 / 1e6 + 200_000 * 4 * 1.25 / 1e6 + 400_000 * 4 * 2 / 1e6, 9);
  });
});

/** Fast mode prices, from the official page: Opus 5.5 $8/$40, Opus 5 and 4.8 $10/$50. */
describe("fast mode has its own prices, on the three models that have it", () => {
  test("the rows", () => {
    expect(modelPrice("claude-opus-5-5")?.fast).toEqual({ input: 8, output: 40 });
    expect(modelPrice("claude-opus-5-5[1m]")?.fast).toEqual({ input: 8, output: 40 });
    expect(modelPrice("claude-opus-5")?.fast).toEqual({ input: 10, output: 50 });
    expect(modelPrice("claude-opus-4-8")?.fast).toEqual({ input: 10, output: 50 });
    expect(modelPrice("claude-opus-4-7")?.fast).toBeUndefined();
    expect(modelPrice("claude-sonnet-5-5")?.fast).toBeUndefined();
  });

  test("a fast Opus 5.5 call uses its fast rates for fresh, cached, and output tokens", () => {
    expect(calculateCostWithCache({
      model: "claude-opus-5-5",
      freshInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
      fastMode: true,
    })).toBeCloseTo(74.4, 9);

    const fastCall: PricedCall = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheRead: 0,
      cacheCreation: 0,
      cacheCreation1h: 0,
      model: "claude-opus-5-5",
      fastMode: true,
    };
    expect(callsCostUsd([fastCall], "unknown")).toBeCloseTo(48, 9);
  });
});

/**
 * Retired ids are named `claude-3-…`, family after the version. Without rows of
 * their own the family fallback sent them to the 5.5 models.
 */
describe("retired ids keep their own prices", () => {
  test("Claude 3.7 Sonnet and 3.5 Haiku", () => {
    expect(calculateCost("claude-3-7-sonnet-20250219", 1_000_000, 1_000_000)).toBeCloseTo(3 + 15, 9);
    expect(calculateCost("claude-3-5-haiku-20241022", 1_000_000, 1_000_000)).toBeCloseTo(0.8 + 4, 9);
    expect(ownModelPrice("claude-3-7-sonnet-20250219")?.cacheRead).toBe(0.1);
  });
});

/**
 * The guard that would have caught the bug: a model Topics OFFERS must have a
 * row of its own. Opus 5.5 was in the catalogue for weeks while its price came
 * from a partial match on `claude-opus-5`, and nothing failed.
 */
describe("every model Topics runs has a price of its own", () => {
  test("the native catalogue, its default, and the spawn_agent aliases", async () => {
    const offered = new Set<string>([
      ...(await new NativeProvider({ type: "native" }).listModels()),
      DEFAULT_MODEL,
      ...["opus", "sonnet", "fable", "haiku", "opus[1m]", "sonnet[1m]"].map((a) => engineModelOf(a)!),
    ]);
    const unpriced = [...offered].filter((m) => !ownModelPrice(m));
    expect(unpriced, "models offered without a row in shared/model-pricing.ts").toEqual([]);
  });

  test("an id with no row of its own is reported, even when a fallback would price it", () => {
    expect(ownModelPrice("claude-opus-6")).toBeNull();
    expect(ownModelPrice("claude-opus-5-5-20261001")).not.toBeNull();
    expect(ownModelPrice("claude-haiku-4-5-20251001")).not.toBeNull();
  });
});

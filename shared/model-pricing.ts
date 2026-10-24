/**
 * Model prices in USD per million tokens, with each model's cache-read rate.
 *
 * WHY IT LIVES IN shared/. The server prices a turn (`server/usage/pricing.ts`)
 * and the client splits that price into "cache" and "the rest"
 * (`client/src/lib/cacheBreakdown.ts`). Both need the same cache-read rate, and
 * since the 5.5 generation that rate is no longer one number for the whole
 * family: two copies of it is how the client kept saying "x0.1" while Opus 5.5
 * reads at x0.05.
 *
 * WHAT WENT WRONG BEFORE (24/10/2026). The table had no 5.5 rows. A partial
 * match sent `claude-opus-5-5` to the `claude-opus-5` row ($5/$25) and every
 * cache read was billed at a flat x0.1: on a cache-heavy turn that is about
 * twice the real bill (turn 4 of the finance chat: $13.27 shown, $6.04 real).
 * `claude-haiku-5-5` matched no row at all and fell back to Haiku 4.5, ten
 * times its price.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing, read on
 * 2026-10-24. "Cache hits and refreshes" are 0.025x on Fable/Mythos 5.1,
 * 0.05x on Opus 5.5 and Sonnet 5.5, 0.1x on every other model. Cache writes
 * are 1.25x (5 minutes) and 2x (one hour) on every Claude model.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** Cache hits and refreshes, as a fraction of `input`. */
  cacheRead: number;
  /**
   * Prices for a request whose prompt (fresh + cache writes + cache reads) is
   * over `over` tokens. Only Claude Haiku 5.5 has two rate cards today.
   */
  longPrompt?: { over: number; input: number; output: number };
  /**
   * Fast mode prices, on the models that have it. Cache multipliers apply on
   * top of these, as on the standard prices.
   */
  fast?: { input: number; output: number };
}

/** The cache-read rate of every model without a rate of its own. */
export const STANDARD_CACHE_READ = 0.1;

function price(input: number, output: number, cacheRead = STANDARD_CACHE_READ): ModelPrice {
  return { input, output, cacheRead };
}

/** A row with fast mode: Opus 5.5 at 8/40, Opus 5 and 4.8 at 10/50 (twice the standard price). */
function withFast(row: ModelPrice, input: number, output: number): ModelPrice {
  return { ...row, fast: { input, output } };
}

const PRICE_TABLE: Record<string, ModelPrice> = {
  // Claude, current generation.
  "claude-fable-5-1": price(10, 50, 0.025),
  "claude-mythos-5-1": price(10, 50, 0.025),
  "claude-fable-5": price(10, 50),
  "claude-mythos-5": price(10, 50),
  "claude-opus-5-5": withFast(price(4, 20, 0.05), 8, 40),
  "claude-opus-5": withFast(price(5, 25), 10, 50),
  "claude-opus-4-8": withFast(price(5, 25), 10, 50),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-sonnet-5-5": price(2, 10, 0.05),
  // $2/$10 was launch pricing and became the standard price: the move to
  // $3/$15 announced for 1 September 2026 was cancelled.
  "claude-sonnet-5": price(2, 10),
  "claude-sonnet-4-6": price(3, 15),
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: STANDARD_CACHE_READ, longPrompt: { over: 100_000, input: 0.5, output: 2.5 } },
  "claude-haiku-4-5": price(1, 5),
  // Claude, legacy: still in old messages.
  "claude-opus-4-5": price(5, 25),
  "claude-opus-4-1": price(15, 75),
  "claude-sonnet-4-5": price(3, 15),
  "claude-opus-4-20250514": price(15, 75),
  "claude-sonnet-4-20250514": price(3, 15),
  // Older ids are named `claude-3-…`, family after the version: without their
  // own rows the family fallback priced them as the 5.5 models.
  "claude-3-7-sonnet": price(3, 15),
  "claude-3-5-haiku": price(0.8, 4),
  // OpenAI. Their cached-input discount is not modelled: these turns are not
  // priced with cache shares today, so the standard rate only keeps the old
  // behaviour.
  "gpt-4o": price(2.5, 10),
  "gpt-4o-mini": price(0.15, 0.6),
  "gpt-o3": price(10, 40),
  "gpt-o3-mini": price(1.1, 4.4),
};

/**
 * Normalises a model id before matching. The window suffix
 * (`claude-opus-5-5[1m]`) is part of the id the CLI reports, not of the model
 * name, and the model is the same: same price. Same normalisation as
 * `shared/context-window.ts`.
 */
function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]*\]\s*$/, "").trim();
}

/**
 * The row of a model, or null. Exact key first, then the longest key the id
 * contains (so `claude-opus-5-5-20261001` lands on `claude-opus-5-5`, not on
 * `claude-opus-5`), then the CURRENT model of the family.
 */
export function modelPrice(model: string): ModelPrice | null {
  const exact = ownModelPrice(model);
  if (exact) return exact;
  const lower = normalizeModel(model);
  const keys = Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length);
  // Only the model name may contain the key, never the reverse: "gpt-4o"
  // must not land on the longer "gpt-4o-mini".
  const hit = keys.find((key) => lower.includes(key));
  if (hit) return PRICE_TABLE[hit]!;
  return familyFallback(lower);
}

/**
 * The row written for THIS model (window suffix and date suffix ignored), or
 * null when the price would come from a partial match or a family fallback.
 * It is the question the catalogue test asks: a model Topics offers must not
 * be priced by resemblance, because resemblance is exactly how Opus 5.5 got
 * billed as Opus 5.
 */
export function ownModelPrice(model: string): ModelPrice | null {
  const lower = normalizeModel(model);
  return PRICE_TABLE[lower] ?? PRICE_TABLE[lower.replace(/-\d{8}$/, "")] ?? null;
}

/**
 * A model of a known family that has no row yet is priced as the CURRENT model
 * of that family, not as the first one written here: a table that ages must not
 * make every new model look as expensive as the oldest one.
 */
function familyFallback(lower: string): ModelPrice | null {
  if (lower.includes("fable") || lower.includes("mythos")) return PRICE_TABLE["claude-fable-5-1"]!;
  if (lower.includes("opus")) return PRICE_TABLE["claude-opus-5-5"]!;
  if (lower.includes("sonnet")) return PRICE_TABLE["claude-sonnet-5-5"]!;
  if (lower.includes("haiku")) return PRICE_TABLE["claude-haiku-5-5"]!;
  if (lower.includes("o3-mini")) return PRICE_TABLE["gpt-o3-mini"]!;
  if (lower.includes("o3")) return PRICE_TABLE["gpt-o3"]!;
  return null;
}

/**
 * The cache-read rate of a model, for code that splits a cost it did not
 * compute. An unknown model keeps the standard rate: that was the only rate
 * before, so nothing that worked changes.
 */
export function cacheReadRate(model: string | null | undefined): number {
  return (model ? modelPrice(model)?.cacheRead : undefined) ?? STANDARD_CACHE_READ;
}

/**
 * Input and output prices for a request with `promptTokens` of prompt. Equal to
 * the row except for Haiku 5.5 over 100k tokens, where the whole request,
 * cache reads included, moves to the second rate card.
 */
export function ratesForPrompt(row: ModelPrice, promptTokens: number): { input: number; output: number } {
  if (row.longPrompt && promptTokens > row.longPrompt.over) {
    return { input: row.longPrompt.input, output: row.longPrompt.output };
  }
  return { input: row.input, output: row.output };
}

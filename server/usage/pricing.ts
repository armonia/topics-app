/**
 * Turn and call prices in USD.
 *
 * The table itself lives in `shared/model-pricing.ts`, because the client
 * splits these same prices into "cache" and "the rest" and needs each model's
 * cache-read rate. What stays here is the arithmetic and the memory of models
 * that could not be priced.
 *
 * Two lessons from the history of this file, both still enforced:
 *   - the family fallback points to the CURRENT model of the family: in August
 *     every Opus fell back to a retired $15/$75 row and showed three times the
 *     real cost (643.66$ shown, 214.55$ real on the sample);
 *   - an UNKNOWN model has to be visible. It used to return 0 with a
 *     `console.warn`, that is "free", which looks exactly like a turn that cost
 *     nothing.
 */
import { modelPrice, ownModelPrice, ratesForPrompt, type ModelPrice } from "../../shared/model-pricing";
import { accumulateTurnUsage, emptyTurnUsage, turnUsageParts, type CallUsage } from "./turn-usage";

export { modelPrice };

/** Models seen without a price, so the status panel can SAY so instead of billing zero. */
const unknownModels = new Set<string>();
/** Models priced by resemblance (a partial match or the family fallback), warned once each. */
const approximatedModels = new Set<string>();

/** Model names that have no price in the table. Empty = everything priced. */
export function unknownPricedModels(): string[] {
  return [...unknownModels];
}

/**
 * `modelPrice` plus the two registries. "Free" looks exactly like a turn that
 * really cost nothing, so it has to be SAID; and a price found by resemblance
 * is how Opus 5.5 was billed as Opus 5 for weeks without a single line in the
 * log, so that is said too, once per model.
 */
function findPricing(model: string): ModelPrice | null {
  const price = modelPrice(model);
  if (!price) {
    if (!unknownModels.has(model)) {
      unknownModels.add(model);
      console.warn(`[usage] Model without a price: "${model}". These turns cost 0 until it is added to shared/model-pricing.ts.`);
    }
    return null;
  }
  if (!ownModelPrice(model) && !approximatedModels.has(model)) {
    approximatedModels.add(model);
    console.warn(`[usage] Model priced by resemblance: "${model}" has no row of its own in shared/model-pricing.ts.`);
  }
  return price;
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number, fastMode = false): number {
  const pricing = findPricing(model);
  if (!pricing) return 0;
  const rates = ratesForPrompt(pricing, inputTokens, fastMode);
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

/**
 * Cache WRITE multipliers over the input price, the same on every Claude model:
 * 1.25x with a five-minute TTL, 2x with a one-hour TTL. The READ rate is not
 * here any more: it depends on the model (0.025x on Fable 5.1, 0.05x on Opus
 * and Sonnet 5.5, 0.1x elsewhere) and lives in each row of
 * `shared/model-pricing.ts`.
 *
 * Why the cache matters so much: in a long agentic turn the same prompt is
 * read again from the cache at every model call, and the turn total reaches
 * millions of tokens of pure rereading. Billing them as fresh input made a ~$9
 * turn show $90; billing them at a flat 0.1x made an Opus 5.5 turn show twice
 * its cost.
 *
 * The two TTLs are billed separately because the usage reports them separately
 * (`ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`): on a real
 * session measured on 30/07 every write (2.32M tokens) was at one hour, and
 * billing them at 1.25x understated the bill by 17.6%. Callers that only have
 * the total keep passing `cacheCreationTokens`.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** One-hour TTL write: twice a fresh token. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/**
 * Cost of ONE request with the cache tokens billed for what they are.
 * `freshInputTokens` are the prompt tokens that did NOT come from the cache:
 * callers usually start from a total that contains all three, so subtract
 * first (see `splitPromptTokens`).
 *
 * The numbers are priced as a single request. That is exact for one call, and
 * for every model but Haiku 5.5 it is exact for a sum of calls too. Haiku 5.5
 * picks its rate card per request (over 100k tokens of prompt the whole request
 * costs five times more): a sum of calls priced here is an upper bound, and code
 * that has the calls one by one prices them with `callsCostUsd`.
 */
export function calculateCostWithCache(args: {
  model: string;
  freshInputTokens: number;
  outputTokens: number;
  fastMode?: boolean;
  cacheReadTokens?: number;
  /** Five-minute writes (1.25x). Callers with only the total pass it here. */
  cacheCreationTokens?: number;
  /**
   * One-hour writes (2x), DISJOINT from `cacheCreationTokens`: passing the same
   * total in both would count it twice. From
   * `usage.cache_creation.ephemeral_1h_input_tokens`.
   */
  cacheCreation1hTokens?: number;
}): number {
  const pricing = findPricing(args.model);
  if (!pricing) return 0;
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const fresh = n(args.freshInputTokens);
  const write5m = n(args.cacheCreationTokens);
  const write1h = n(args.cacheCreation1hTokens);
  const read = n(args.cacheReadTokens);
  const rates = ratesForPrompt(pricing, fresh + write5m + write1h + read, args.fastMode === true);
  const inputCost =
    fresh * rates.input +
    write5m * rates.input * CACHE_WRITE_MULTIPLIER +
    write1h * rates.input * CACHE_WRITE_1H_MULTIPLIER +
    read * rates.input * pricing.cacheRead;
  return (inputCost + n(args.outputTokens) * rates.output) / 1_000_000;
}

/** One model call as the provider reports it, with the model that served it when known. */
export type PricedCall = CallUsage & { model?: string };

/**
 * The cost of a list of model calls: each one priced on its own, then summed.
 *
 * WHY NOT THE TOTAL. Haiku 5.5 chooses its rate card per request. A turn of
 * calls at 60k, 80k, 120k and 140k tokens of prompt pays the cheap card on the
 * first two and the long card on the last two; priced from the turn total, or
 * from its average, it lands on one card for all four and
 * is off by a factor of three either way. On every other model the sum equals
 * the price of the total.
 *
 * `fallbackModel` prices the calls that did not say which model served them.
 */
export function callsCostUsd(calls: readonly PricedCall[], fallbackModel: string): number {
  let usd = 0;
  for (const call of calls) {
    const parts = turnUsageParts(accumulateTurnUsage(emptyTurnUsage(), call));
    usd += calculateCostWithCache({
      model: call.model || fallbackModel,
      freshInputTokens: parts.fresh,
      outputTokens: parts.output,
      fastMode: call.fastMode,
      cacheReadTokens: parts.cacheRead,
      cacheCreationTokens: parts.cacheCreation5m,
      cacheCreation1hTokens: parts.cacheCreation1h,
    });
  }
  return usd;
}

/**
 * One call in the API's own shape (`input` = fresh only, the cache shares
 * apart, `cacheWrite1h` a part of `cacheWrite`), priced with `model`. Null when
 * the model has no price: the caller then knows the session's per-call sum is
 * incomplete, instead of reading a zero as "free".
 */
export function apiCallCostUsd(
  model: string | null | undefined,
  call: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; fastMode?: boolean },
): number | null {
  if (!model || !modelPrice(model)) return null;
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  return callsCostUsd([{
    inputTokens: n(call.input) + n(call.cacheRead) + n(call.cacheWrite),
    outputTokens: n(call.output),
    fastMode: call.fastMode,
    cacheRead: n(call.cacheRead),
    cacheCreation: n(call.cacheWrite),
    cacheCreation1h: n(call.cacheWrite1h),
  }], model);
}

/**
 * Da "totale dei token di prompt" (fresco + scrittura + rilettura, che è come
 * lo consegna il provider) alle tre quote separate. Non va mai sotto zero: un
 * provider che riporta quote incoerenti deve produrre un costo basso, non un
 * credito.
 */
export function splitPromptTokens(args: {
  promptTokensTotal: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): { fresh: number; cacheRead: number; cacheCreation: number } {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const cacheRead = n(args.cacheReadTokens);
  const cacheCreation = n(args.cacheCreationTokens);
  const fresh = Math.max(0, n(args.promptTokensTotal) - cacheRead - cacheCreation);
  return { fresh, cacheRead, cacheCreation };
}

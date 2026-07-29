// Model pricing in USD per 1M tokens
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-5-20250918': { input: 15, output: 75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4 },
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-o3': { input: 10, output: 40 },
  'gpt-o3-mini': { input: 1.10, output: 4.40 },
};

// Fuzzy match model name to pricing entry
function findPricing(model: string): { input: number; output: number } | null {
  // Exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Partial match: check if model string contains a known key
  // Sort by longest key first so "gpt-4o-mini" matches before "gpt-4o"
  const lower = model.toLowerCase();
  const sortedEntries = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [key, pricing] of sortedEntries) {
    // Only match when the MODEL NAME contains a known pricing key. The reverse
    // direction (key contains model) misclassified short names — e.g. model
    // "gpt-4o" matched the longer key "gpt-4o-mini" (checked first by length)
    // and billed at the wrong rate. Short aliases ("opus", "o3") fall through
    // to the explicit family fallbacks below.
    if (lower.includes(key.toLowerCase())) {
      return pricing;
    }
  }

  // Family match
  if (lower.includes('opus')) return MODEL_PRICING['claude-opus-4-6'];
  if (lower.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4-20250514'];
  if (lower.includes('haiku')) return MODEL_PRICING['claude-haiku-3-5-20241022'];
  if (lower.includes('gpt-4o-mini')) return MODEL_PRICING['gpt-4o-mini'];
  if (lower.includes('gpt-4o')) return MODEL_PRICING['gpt-4o'];
  if (lower.includes('o3-mini')) return MODEL_PRICING['gpt-o3-mini'];
  if (lower.includes('o3')) return MODEL_PRICING['gpt-o3'];

  return null;
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = findPricing(model);
  if (!pricing) {
    console.warn(`[usage] Unknown model "${model}" — cost will not be tracked. Add pricing to MODEL_PRICING.`);
    return 0;
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * Moltiplicatori della cache rispetto al prezzo dell'input, uguali su tutta la
 * famiglia Claude: SCRIVERE nella cache costa un quarto in più di un token
 * fresco, RILEGGERLA costa un decimo.
 *
 * Perché contano così tanto: in un turno agentico lungo lo stesso prompt viene
 * riletto dalla cache a ogni chiamata al modello, e l'aggregato di fine turno
 * arriva a milioni di token di sola rilettura. Trattarli come input fresco —
 * quello che faceva `calculateCost` da sola, ricevendo un `inputTokens` che li
 * conteneva già — gonfia il costo di circa dieci volte: un turno da ~$9 veniva
 * mostrato a $90.
 *
 * NB: la scrittura a 1 ora costa 2×, non 1.25×. La CLI aggrega le due durate in
 * `cache_creation_input_tokens`, quindi qui si usa la tariffa a 5 minuti; lo
 * scarto è sui soli token di scrittura, ordini di grandezza sotto l'errore che
 * questa funzione elimina.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Costo di una chiamata (o di un turno aggregato) con i token della cache
 * tariffati per quello che sono. `freshInputTokens` sono i token di prompt che
 * NON venivano dalla cache: chi chiama parte quasi sempre da un totale che li
 * comprende tutti e tre, quindi sottragga prima (vedi `splitPromptTokens`).
 */
export function calculateCostWithCache(args: {
  model: string;
  freshInputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): number {
  const pricing = findPricing(args.model);
  if (!pricing) {
    console.warn(`[usage] Unknown model "${args.model}" — cost will not be tracked. Add pricing to MODEL_PRICING.`);
    return 0;
  }
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const inputCost =
    n(args.freshInputTokens) * pricing.input +
    n(args.cacheCreationTokens) * pricing.input * CACHE_WRITE_MULTIPLIER +
    n(args.cacheReadTokens) * pricing.input * CACHE_READ_MULTIPLIER;
  return (inputCost + n(args.outputTokens) * pricing.output) / 1_000_000;
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

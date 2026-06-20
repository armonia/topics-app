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

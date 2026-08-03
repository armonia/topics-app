/**
 * Prezzi in USD per 1M token.
 *
 * Questa tabella era ferma a modelli che NON si usano più, e il danno non era
 * "un prezzo mancante": era un prezzo SBAGLIATO, applicato in silenzio. Nessuna
 * delle chiavi vecchie compariva nei modelli reali (`claude-opus-4-8`,
 * `claude-opus-5`, …), quindi ogni turno Opus cadeva nel ripiego di famiglia —
 * che puntava al modello più VECCHIO della famiglia, a 15$/75$ — e finiva
 * tariffato al TRIPLO dei 5$/25$ veri. Misurato sul DB di prod: 643,66$
 * mostrati contro 214,55$ reali sul campione.
 *
 * Due lezioni, entrambe cablate qui sotto:
 *   · il ripiego di famiglia deve puntare al modello CORRENTE, non al primo che
 *     è stato scritto: sbagliare per difetto (un modello nuovo più economico
 *     tariffato come il vecchio) è meno peggio che sbagliare per eccesso, e
 *     comunque il ripiego non deve invecchiare da solo;
 *   · un modello SCONOSCIUTO deve vedersi. Prima tornava `0` con un
 *     `console.warn`, cioè "gratis" — indistinguibile da un turno che davvero
 *     non è costato niente.
 *
 * Fonte: tabella prezzi ufficiale (skill `claude-api`), aggiornata al 2026-08-03.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude — generazione corrente
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Claude — legacy, ancora nei messaggi vecchi
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4 },
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-o3': { input: 10, output: 40 },
  'gpt-o3-mini': { input: 1.10, output: 4.40 },
};

/** I modelli visti e non riconosciuti, per poterlo DIRE invece di tariffare zero. */
const unknownModels = new Set<string>();

/** I nomi di modello che non hanno un prezzo in tabella. Vuoto = tutto tariffato. */
export function unknownPricedModels(): string[] {
  return [...unknownModels];
}

/**
 * Normalizza un id di modello prima del match.
 *
 * Il suffisso di finestra — `claude-opus-5[1m]` — fa parte dell'id che la CLI
 * riporta, non del nome del modello: senza toglierlo la chiave esatta non matcha
 * mai e si finisce nel ripiego. Stessa normalizzazione di
 * `shared/context-window.ts`.
 *
 * Il modello è lo STESSO, quindi la tariffa è la stessa. Non è modellato il
 * sovrapprezzo che il beta 1M applica alle richieste sopra i 200k token: qui si
 * lavora ad abbonamento, dove quel numero non è denaro ma un promemoria, e una
 * soglia inventata a metà sarebbe meno vera di una tariffa piatta.
 */
function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]*\]\s*$/, '').trim();
}

// Fuzzy match model name to pricing entry
function findPricing(model: string): { input: number; output: number } | null {
  // Exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  const lower = normalizeModel(model);
  if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];

  // Partial match: check if model string contains a known key
  // Sort by longest key first so "gpt-4o-mini" matches before "gpt-4o"
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

  // Ripiego di famiglia — sul modello CORRENTE della famiglia, non sul primo
  // che è stato scritto in questo file.
  if (lower.includes('fable') || lower.includes('mythos')) return MODEL_PRICING['claude-fable-5'];
  if (lower.includes('opus')) return MODEL_PRICING['claude-opus-5'];
  if (lower.includes('sonnet')) return MODEL_PRICING['claude-sonnet-5'];
  if (lower.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  if (lower.includes('gpt-4o-mini')) return MODEL_PRICING['gpt-4o-mini'];
  if (lower.includes('gpt-4o')) return MODEL_PRICING['gpt-4o'];
  if (lower.includes('o3-mini')) return MODEL_PRICING['gpt-o3-mini'];
  if (lower.includes('o3')) return MODEL_PRICING['gpt-o3'];

  if (!unknownModels.has(model)) {
    unknownModels.add(model);
    console.warn(`[usage] Modello senza prezzo: "${model}" — il costo di questi turni resta a 0. Aggiungilo a MODEL_PRICING.`);
  }
  return null;
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = findPricing(model);
  if (!pricing) return 0;
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
 * Le due durate hanno tariffe diverse: 1.25× a 5 minuti, 2× a un'ora. Qui c'era
 * scritto che la CLI le aggrega in `cache_creation_input_tokens` e che lo scarto
 * è «ordini di grandezza» sotto — **entrambe le cose sono false**, misurate il
 * 30/07 su una sessione reale: l'usage porta `cache_creation` scorporato in
 * `ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`, e su quella sessione
 * il 100% delle scritture (2,32M token) era a un'ora. Tariffarle tutte a 1.25×
 * sottostimava il conto del 17,6%.
 *
 * Chi sa distinguere passi `cacheCreation1hTokens`; chi ha solo il totale
 * continui a passare `cacheCreationTokens` e ottiene il comportamento di prima.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** Scrittura con TTL a un'ora: il doppio di un token fresco. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;
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
  /** Scritture a 5 minuti (1.25×). Chi ha solo il totale lo passi qui, come prima. */
  cacheCreationTokens?: number;
  /**
   * Scritture a un'ora (2×), quota DISGIUNTA da `cacheCreationTokens` — sommarle
   * entrambe con lo stesso totale conterebbe due volte. Viene da
   * `usage.cache_creation.ephemeral_1h_input_tokens`.
   */
  cacheCreation1hTokens?: number;
}): number {
  const pricing = findPricing(args.model);
  if (!pricing) return 0;
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const inputCost =
    n(args.freshInputTokens) * pricing.input +
    n(args.cacheCreationTokens) * pricing.input * CACHE_WRITE_MULTIPLIER +
    n(args.cacheCreation1hTokens) * pricing.input * CACHE_WRITE_1H_MULTIPLIER +
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

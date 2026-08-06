/**
 * Prezzi in USD per 1M token — il LATO SERVER della tabella.
 *
 * La tabella vera vive in `shared/model-pricing.ts` da quando anche il client
 * ha dovuto dire quanto costa un modello (il badge del Fast Mode): il client
 * non può importare da `server/`, e due copie dello stesso listino sono due
 * numeri che fra sei mesi divergono. Qui restano le cose che solo il server ha:
 * il conto vero di un turno (cache inclusa) e il REGISTRO dei modelli visti
 * senza prezzo, che è memoria di processo e non ha senso in venti tab.
 */
import { modelPrice } from "../../shared/model-pricing";

export { MODEL_PRICING, modelPrice, costMultiplier, normalizeModel } from "../../shared/model-pricing";
export type { ModelPrice } from "../../shared/model-pricing";

/** I modelli visti e non riconosciuti, per poterlo DIRE invece di tariffare zero. */
const unknownModels = new Set<string>();

/** I nomi di modello che non hanno un prezzo in tabella. Vuoto = tutto tariffato. */
export function unknownPricedModels(): string[] {
  return [...unknownModels];
}

/**
 * Il prezzo, più l'effetto collaterale che il pannello di stato usa: un modello
 * senza tariffa va REGISTRATO, non tariffato zero — «gratis» è
 * indistinguibile da un turno che davvero non è costato niente.
 */
function findPricing(model: string): { input: number; output: number } | null {
  const price = modelPrice(model);
  if (price) return price;
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

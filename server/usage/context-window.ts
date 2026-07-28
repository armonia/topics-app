/**
 * Il DENOMINATORE del ring del contesto: quanto ci sta nella finestra del
 * modello.
 *
 * Il numeratore lo sappiamo già misurare bene (`onContextSize`:
 * `input + cache_read + cache_creation` di UNA chiamata). Il denominatore
 * finora non stava scritto da nessuna parte: `/api/context` cablava `200000`
 * in tre punti diversi come costante muta, quindi una sessione su una finestra
 * da 1M leggeva "al 90%" quando era al 18%.
 *
 * Due proprietà volute:
 *  • un modello sconosciuto non fa esplodere niente — cade sul default e lo
 *    DICHIARA (`estimated: true`), così la UI può dire "≈" invece di mentire
 *    con una precisione che non ha;
 *  • le soglie stanno QUI, non nel componente che disegna il cerchio: il
 *    preavviso di compaction e il colore del ring devono accendersi sullo
 *    stesso numero, altrimenti l'umano vede un anello ambra e un allarme rosso
 *    che si contraddicono.
 */

/** Finestra usata quando il modello non è in tabella. Il minimo comune moderno. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Chiave → finestra in token. Il match è per SOTTOSTRINGA sul nome del modello
 * (chiavi più lunghe per prime), come fa `pricing.ts`: i nomi che arrivano dai
 * provider sono pieni di date e suffissi (`claude-sonnet-4-5-20250929`) e una
 * tabella di uguaglianze esatte invecchia in una settimana.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  // Claude — 200k di serie su tutta la famiglia.
  "claude-opus-4": 200_000,
  "claude-opus-5": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-sonnet-5": 200_000,
  "claude-haiku-3-5": 200_000,
  "claude-haiku-4-5": 200_000,
  // OpenAI.
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
  "gpt-4-1": 1_047_576,
  "gpt-4.1": 1_047_576,
  "gpt-5-codex": 400_000,
  "gpt-5": 400_000,
  "o3-mini": 200_000,
  "o3": 200_000,
  // Gemini.
  "gemini-2-5-pro": 1_048_576,
  "gemini-2.5-pro": 1_048_576,
};

/**
 * Varianti a finestra lunga: lo stesso modello, servito con la beta 1M. Il
 * suffisso vince sulla famiglia, quindi si controlla PRIMA della tabella.
 */
const LONG_WINDOW_MARKERS = ["[1m]", "-1m", ":1m", "1m-context", "context-1m"];

export interface ContextWindow {
  /** Token che il modello regge in ingresso. */
  tokens: number;
  /** false = il modello non è in tabella, `tokens` è il default. */
  known: boolean;
}

/** Finestra di contesto per un nome di modello (fuzzy, mai lancia). Pura. */
export function contextWindowFor(model: string | null | undefined): ContextWindow {
  if (!model || typeof model !== "string") return { tokens: DEFAULT_CONTEXT_WINDOW, known: false };
  const lower = model.toLowerCase();

  if (LONG_WINDOW_MARKERS.some((m) => lower.includes(m))) return { tokens: 1_000_000, known: true };

  const keys = Object.keys(CONTEXT_WINDOWS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return { tokens: CONTEXT_WINDOWS[key]!, known: true };
  }

  // Fallback di famiglia: gli alias corti ("opus", "sonnet") arrivano dal
  // selettore del modello e dalle preferenze, non dal provider.
  if (lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
    return { tokens: 200_000, known: true };
  }

  return { tokens: DEFAULT_CONTEXT_WINDOW, known: false };
}

export type ContextLevel = "ok" | "warn" | "critical";

/** Sopra questa percentuale il ring è ambra. */
export const CONTEXT_WARN_PERCENT = 70;
/**
 * Sopra questa percentuale il ring è rosso E scatta il preavviso di
 * compaction. Sta sotto la soglia a cui la CLI compatta da sola: il punto è
 * dare all'umano il tempo di scegliere (compatta ora / apri una chat nuova)
 * PRIMA che la scelta gliela faccia il sistema.
 */
export const CONTEXT_CRITICAL_PERCENT = 90;

export function contextLevel(percent: number): ContextLevel {
  if (percent >= CONTEXT_CRITICAL_PERCENT) return "critical";
  if (percent >= CONTEXT_WARN_PERCENT) return "warn";
  return "ok";
}

export interface ContextUsage {
  /** Token nel prompt dell'ultima chiamata (il numeratore onesto). */
  used: number;
  /** Finestra del modello (il denominatore). */
  size: number;
  /** 0–100, arrotondata. Satura a 100: oltre la finestra non esiste "110%". */
  percent: number;
  level: ContextLevel;
  /** true = finestra dedotta dal default, non dal modello. */
  estimated: boolean;
}

/** Numeratore + denominatore → quello che la UI disegna. Pura. */
export function classifyContext(used: number, window: ContextWindow): ContextUsage {
  const size = window.tokens > 0 ? window.tokens : DEFAULT_CONTEXT_WINDOW;
  const safeUsed = Number.isFinite(used) && used > 0 ? Math.round(used) : 0;
  const percent = Math.min(100, Math.round((safeUsed / size) * 100));
  return { used: safeUsed, size, percent, level: contextLevel(percent), estimated: !window.known };
}

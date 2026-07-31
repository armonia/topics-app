/**
 * Quanto ci sta nella finestra di un modello. UNA tabella, due lettori.
 *
 * Stava solo nel server (`server/usage/context-window.ts`), perché serviva solo
 * al denominatore del ring. Poi il picker dei modelli ha dovuto dire la stessa
 * cosa — «questo modello quanto contesto regge» — e il client non può importare
 * da `server/` (TS6307, e il confine è cablato in
 * `tests/unit/no-type-mirrors.test.ts`). Le alternative erano due: ricopiare la
 * tabella nel client, cioè garantire che fra sei mesi le due copie dicano numeri
 * diversi sullo stesso modello, oppure spostarla dove entrambi possono leggerla.
 * È qui per questo.
 *
 * Il server continua a importarla dal suo modulo, che la ri-esporta: nessun
 * chiamante storico cambia una riga.
 *
 * Due proprietà volute, e sono le stesse di prima:
 *  • un modello sconosciuto non fa esplodere niente — cade sul default e lo
 *    DICHIARA (`known: false`), così chi disegna può dire "≈" invece di mentire
 *    con una precisione che non ha;
 *  • il match è per SOTTOSTRINGA (chiavi più lunghe per prime), come
 *    `pricing.ts`: i nomi che arrivano dai provider sono pieni di date e
 *    suffissi (`claude-sonnet-4-5-20250929`) e una tabella di uguaglianze esatte
 *    invecchia in una settimana.
 */
// Il default vive in `context-thresholds.ts` e si importa DA LI'. Questo modulo
// lo usa soltanto: ri-esportarlo aggiungeva una terza porta per la stessa
// costante (`shared/context-thresholds`, `server/usage/context-window`, qui) e
// nessuno passava da questa.
import { DEFAULT_CONTEXT_WINDOW } from "./context-thresholds";

/**
 * Chiave → finestra in token.
 *
 * Le chiavi più lunghe vincono (match per sottostringa), quindi `claude-opus-4-5`
 * deve stare PRIMA del generico `claude-opus-4` — se no un 4.5 leggerebbe 1M.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  // Claude. Il milione NON è una variante: è la finestra di serie da Opus 4.6 e
  // Sonnet 4.6 in avanti, e su tutta la generazione 5. Restano a 200k solo i
  // modelli davvero vecchi e Haiku.
  "claude-fable-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4": 200_000,
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

/** true = il nome dichiara la variante a finestra lunga. */
export function hasLongWindowMarker(model: string | null | undefined): boolean {
  if (!model || typeof model !== "string") return false;
  const lower = model.toLowerCase();
  return LONG_WINDOW_MARKERS.some((m) => lower.includes(m));
}

/** Toglie il marcatore di modalità dal nome, lasciando il modello nudo. */
export function stripLongWindowMarker(model: string): string {
  let out = model;
  for (const m of LONG_WINDOW_MARKERS) {
    const i = out.toLowerCase().indexOf(m);
    if (i >= 0) out = out.slice(0, i) + out.slice(i + m.length);
  }
  return out;
}

/**
 * Quale nome usare per DIMENSIONARE la finestra, dati quello richiesto e quello
 * che ha davvero servito la chiamata.
 *
 * Il problema: `[1m]` è una modalità di servizio, non un modello diverso, e la
 * CLI nei suoi eventi riporta il nome NUDO (`claude-opus-5`). Chi sceglieva
 * "1M" dal picker si vedeva quindi il denominatore a 200k e un anello al 90%
 * mentre era al 18% — il numero giusto c'era, lo perdeva chi lo riportava.
 *
 * La regola: il suffisso della richiesta sopravvive solo se la chiamata è stata
 * servita dallo STESSO modello. Se la CLI è ripiegata su un altro (fast mode,
 * sovraccarico), comanda il modello che ha risposto, finestra compresa — è lui
 * che dimensiona il turno.
 */
export function windowModelFor(
  perCallModel: string | null | undefined,
  requestedModel: string | null | undefined,
): string | null {
  const perCall = perCallModel || null;
  const requested = requestedModel || null;
  if (!perCall) return requested;
  if (!requested) return perCall;
  if (hasLongWindowMarker(perCall) || !hasLongWindowMarker(requested)) return perCall;
  // La richiesta è a finestra lunga e la risposta ha perso il suffisso: è lo
  // stesso modello solo se un nome è il prefisso dell'altro una volta tolto il
  // marcatore (la CLI può aggiungere una data: `claude-opus-5-20260101`).
  const base = stripLongWindowMarker(requested);
  const a = perCall.toLowerCase();
  const b = base.toLowerCase();
  return a.startsWith(b) || b.startsWith(a) ? requested : perCall;
}

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
  // selettore del modello e dalle preferenze, non dal provider. Un alias nudo
  // significa "l'ultimo di quella famiglia", che oggi è a 1M; solo Haiku è ancora
  // a 200k.
  if (lower.includes("haiku")) return { tokens: 200_000, known: true };
  if (lower.includes("opus") || lower.includes("sonnet")) {
    return { tokens: 1_000_000, known: true };
  }

  return { tokens: DEFAULT_CONTEXT_WINDOW, known: false };
}

/**
 * La finestra come si legge in due caratteri e mezzo: `1M`, `400K`, `200K`.
 *
 * Sta qui e non nel componente perché è la stessa domanda della tabella («questo
 * modello quanto regge»), solo detta agli occhi: chi mostra il numero non deve
 * reinventare l'arrotondamento, o la stessa finestra comparirebbe come `1M` in
 * un posto e `1.05M` in un altro. `1_047_576` (gpt-4.1) e `1_048_576` (gemini)
 * sono un milione tondo per chi legge: la differenza è il 5‰ ed è rumore, non
 * informazione.
 */
export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "?";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    // Una decimale solo se cambia la lettura: 1.05M → 1M, 1.5M resta 1.5M.
    return `${Number(m.toFixed(1)).toString()}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

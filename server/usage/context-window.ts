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

/**
 * Finestra usata quando il modello non è in tabella.
 *
 * 1M, non 200k: sull'intera generazione Claude 5 (e già su Opus 4.6+ e Sonnet
 * 4.6) il milione è la finestra DI SERIE, non una variante. Un modello che non
 * conosciamo è quasi sempre più nuovo di questa tabella, quindi il default deve
 * assomigliare al presente. Resta marcato `estimated`, così la UI mostra "≈"
 * invece di spacciare una precisione che non ha.
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Chiave → finestra in token. Il match è per SOTTOSTRINGA sul nome del modello
 * (chiavi più lunghe per prime), come fa `pricing.ts`: i nomi che arrivano dai
 * provider sono pieni di date e suffissi (`claude-sonnet-4-5-20250929`) e una
 * tabella di uguaglianze esatte invecchia in una settimana.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  // Claude. Il milione NON è una variante: è la finestra di serie da Opus 4.6 e
  // Sonnet 4.6 in avanti, e su tutta la generazione 5. Restano a 200k solo i
  // modelli davvero vecchi e Haiku.
  // Le chiavi più lunghe vincono (match per sottostringa), quindi `claude-opus-4-5`
  // deve stare PRIMA del generico `claude-opus-4` — se no un 4.5 leggerebbe 1M.
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

function stripLongWindowMarker(model: string): string {
  let out = model;
  for (const m of LONG_WINDOW_MARKERS) {
    const i = out.toLowerCase().indexOf(m);
    if (i >= 0) out = out.slice(0, i) + out.slice(i + m.length);
  }
  return out;
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
 * La finestra contro cui classificare una misura GIÀ REGISTRATA.
 *
 * Il numeratore è storia (l'ultima chiamata è stata grande quanto è stata); il
 * denominatore è configurazione, e cambia sotto i piedi — l'utente passa a un
 * modello con finestra diversa e il rapporto va riletto. Ricalcolare qui serve a
 * due cose insieme: il cambio di modello si vede subito, e una riga scritta
 * quando la tabella era sbagliata si corregge da sola invece di restare
 * congelata su un denominatore che non è mai stato vero.
 *
 * Se il modello non è in tabella si tiene la finestra registrata con la misura:
 * poteva essere DICHIARATA dal provider (Codex manda `model_context_window`), e
 * un dato dichiarato batte una nostra ipotesi.
 */
export function windowForMeasure(
  measure: { model: string | null; windowTokens: number; estimated: boolean },
  currentModel: string | null | undefined,
): ContextWindow {
  // Il modello del TOPIC vince, e non è la stessa scelta di `windowModelFor`.
  // Quella funzione è retrospettiva: «la CLI ha risposto con X mentre chiedevo Y,
  // quale finestra ha dimensionato QUEL turno». Qui la domanda è opposta —
  // «contro cosa va letto questo contesto ADESSO» — e la risposta è il modello
  // che servirà il turno successivo, perché è lui che dovrà reggere questi token.
  // È anche il ramo che recupera il suffisso `[1m]`: la misura porta il nome nudo
  // che la CLI riporta nei suoi eventi, il topic porta la modalità scelta.
  if (currentModel) {
    const current = contextWindowFor(currentModel);
    if (current.known) return current;
  }
  const fromMeasure = contextWindowFor(measure.model);
  if (fromMeasure.known) return fromMeasure;
  return { tokens: measure.windowTokens, known: !measure.estimated };
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

/**
 * Soglie ASSOLUTE, in token, accanto a quelle percentuali.
 *
 * Da sola la percentuale risponde a «sto per esaurire la finestra?». Su un modello
 * a 1M vuol dire avvisare a 700k, e nel frattempo una sessione che gira a 380k non
 * riceve un fiato — mentre OGNI chiamata rilegge quei 380k. Misurato: ~14 chiamate
 * al modello per turno utente, quindi un turno a 380k costa più di cinque milioni
 * di token di rilettura. La domanda vera non è di capienza, è di prezzo per
 * chiamata, e quella arriva molto prima del 70% di un milione.
 *
 * 200k = la finestra "classica": oltre, un modello a 1M sta pagando un prefisso
 * che i modelli precedenti non avrebbero nemmeno accettato. 400k = il punto in cui
 * un turno agentico costa milioni di token e compattare si ripaga subito.
 */
export const CONTEXT_WARN_TOKENS = 200_000;
export const CONTEXT_CRITICAL_TOKENS = 400_000;

/**
 * Il livello è il PEGGIORE fra quello percentuale e quello assoluto: le due soglie
 * rispondono a domande diverse (capienza / prezzo per chiamata) e sono entrambe
 * buoni motivi per avvisare.
 */
export function contextLevel(percent: number, used?: number): ContextLevel {
  const abs = typeof used === "number" && Number.isFinite(used) ? used : 0;
  if (percent >= CONTEXT_CRITICAL_PERCENT || abs >= CONTEXT_CRITICAL_TOKENS) return "critical";
  if (percent >= CONTEXT_WARN_PERCENT || abs >= CONTEXT_WARN_TOKENS) return "warn";
  return "ok";
}

/**
 * PERCHÉ il livello non è `ok`. Le due soglie rispondono a domande diverse e
 * meritano due messaggi diversi: dire «contesto quasi pieno — 47%» perché è
 * scattata la soglia assoluta è un avviso che l'umano non può capire.
 *
 *  • `window` — sta finendo la finestra (soglia percentuale).
 *  • `cost`   — la finestra è ampia, ma il prompt è già così grande che ogni
 *               chiamata lo rilegge per intero (soglia assoluta).
 */
export type ContextReason = "window" | "cost";

export interface ContextUsage {
  /** Token nel prompt dell'ultima chiamata (il numeratore onesto). */
  used: number;
  /** Finestra del modello (il denominatore). */
  size: number;
  /** 0–100, arrotondata. Satura a 100: oltre la finestra non esiste "110%". */
  percent: number;
  level: ContextLevel;
  /** Assente quando `level` è `ok`: non c'è nulla da spiegare. */
  reason?: ContextReason;
  /** true = finestra dedotta dal default, non dal modello. */
  estimated: boolean;
}

/** Numeratore + denominatore → quello che la UI disegna. Pura. */
export function classifyContext(used: number, window: ContextWindow): ContextUsage {
  const size = window.tokens > 0 ? window.tokens : DEFAULT_CONTEXT_WINDOW;
  const safeUsed = Number.isFinite(used) && used > 0 ? Math.round(used) : 0;
  const percent = Math.min(100, Math.round((safeUsed / size) * 100));
  const level = contextLevel(percent, safeUsed);
  // La capienza vince come spiegazione quando entrambe le soglie sono passate:
  // «sta finendo la finestra» è più urgente di «costa molto per chiamata».
  const reason: ContextReason | undefined =
    level === "ok" ? undefined : percent >= CONTEXT_WARN_PERCENT ? "window" : "cost";
  return { used: safeUsed, size, percent, level, ...(reason ? { reason } : {}), estimated: !window.known };
}

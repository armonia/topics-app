/**
 * Le soglie del contesto — UNA copia, letta da server e client.
 *
 * Stavano solo nel server (`server/usage/context-window.ts`) e il client le
 * riscriveva a mano: `percent > 90` / `percent > 70` in `ContextRing.tsx` e
 * `ContextBudgetBar.tsx`, contro il `>=` del server. Esattamente al 70% il
 * server diceva "warn" e l'anello restava blu — due verità sullo stesso numero,
 * e chi guardava l'anello vedeva quella sbagliata. La soglia assoluta (costo per
 * chiamata) il client non l'aveva affatto: un turno a 380k token su un modello a
 * 1M era ambra secondo il server e blu secondo l'anello.
 *
 * Il file vive in `shared/` perché il confine è quello: chi disegna e chi
 * classifica devono usare la stessa funzione, non lo stesso numero copiato.
 */

/**
 * La finestra da assumere quando il modello non si conosce ancora.
 *
 * 1M e' lo standard della generazione Claude 5 (e di Opus/Sonnet 4.6+): non e'
 * una variante, e' il default. La tabella per-modello vive nel server
 * (`server/usage/context-window.ts`), qui sta solo il numero che serve anche al
 * client per non riscriverlo a mano nei suoi fallback.
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export type ContextLevel = "ok" | "warn" | "critical";

/** Da questa percentuale in su il ring è ambra. */
export const CONTEXT_WARN_PERCENT = 70;
/**
 * Da questa percentuale in su il ring è rosso E scatta il preavviso di
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

/** Il livello secondo la sola capienza. */
export function levelFromPercent(percent: number): ContextLevel {
  if (percent >= CONTEXT_CRITICAL_PERCENT) return "critical";
  if (percent >= CONTEXT_WARN_PERCENT) return "warn";
  return "ok";
}

/** Il livello secondo il solo prezzo per chiamata. */
export function levelFromTokens(used: number): ContextLevel {
  if (used >= CONTEXT_CRITICAL_TOKENS) return "critical";
  if (used >= CONTEXT_WARN_TOKENS) return "warn";
  return "ok";
}

export const LEVEL_RANK: Record<ContextLevel, number> = { ok: 0, warn: 1, critical: 2 };

export function worseLevel(a: ContextLevel, b: ContextLevel): ContextLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/**
 * Il livello è il PEGGIORE fra quello percentuale e quello assoluto: le due soglie
 * rispondono a domande diverse (capienza / prezzo per chiamata) e sono entrambe
 * buoni motivi per avvisare.
 *
 * `used` è opzionale perché non tutti i chiamanti hanno il numeratore in token —
 * la barra dell'inspector stima un preventivo in percentuale. Chi ce l'ha lo passa
 * e ottiene anche la soglia di costo.
 */
export function contextLevel(percent: number, used?: number): ContextLevel {
  const abs = typeof used === "number" && Number.isFinite(used) ? used : 0;
  return worseLevel(levelFromPercent(percent), levelFromTokens(abs));
}

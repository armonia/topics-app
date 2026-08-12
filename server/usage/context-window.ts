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
 *  • le soglie stanno QUI, non nel componente che disegna il cerchio.
 *
 * Fino al 30/07 questa testata dichiarava che ring e preavviso devono accendersi
 * sullo STESSO numero. Non è più vero, ed è voluto: rispondono a due domande
 * diverse. Il ring dice quanto è pieno il serbatoio e colora sulla PERCENTUALE;
 * il preavviso dice quando conviene compattare e guarda anche i token ASSOLUTI,
 * perché su una finestra da un milione il 40% sono già quattrocentomila token che
 * ogni chiamata rilegge. Un anello blu con un avviso di costo non è una
 * contraddizione: è la risposta giusta a due domande diverse, e il testo
 * dell'avviso dice quale delle due ha parlato (`ContextReason`).
 */

/**
 * DOVE STA LA TABELLA. In `shared/context-window.ts`, non più qui: da quando il
 * picker dei modelli mostra la finestra di OGNI modello, la stessa domanda se la
 * fanno server e client, e il client non può importare da `server/` (TS6307).
 * L'alternativa era una seconda copia della tabella nel client, cioè la garanzia
 * che prima o poi i due numeri divergano sullo stesso modello.
 *
 * Questo modulo resta la porta per il server — i chiamanti storici importano da
 * qui e non cambiano una riga — e tiene ciò che è davvero suo: la
 * classificazione di una misura (`classifyContext`, `windowForMeasure`), che
 * parla di `session_context` e di soglie, non di modelli.
 *
 * Finestra usata quando il modello non è in tabella: 1M, non 200k — sull'intera
 * generazione Claude 5 (e già su Opus 4.6+ e Sonnet 4.6) il milione è la
 * finestra DI SERIE. Un modello che non conosciamo è quasi sempre più nuovo
 * della tabella, quindi il default deve assomigliare al presente; resta marcato
 * `estimated`, così la UI mostra "≈" invece di spacciare una precisione che non
 * ha.
 */
import {
  DEFAULT_CONTEXT_WINDOW,
  levelFromPercent,
  levelFromTokens,
  LEVEL_RANK,
  worseLevel,
} from "../../shared/context-thresholds";
import type { ContextLevel } from "../../shared/context-thresholds";
import { contextWindowFor, windowCoveringMeasure } from "../../shared/context-window";
import type { ContextWindow } from "../../shared/context-window";

// Si ri-esporta SOLO ciò che qualcuno importa da qui (i test di questo modulo e
// i chiamanti server). Il marcatore di finestra lunga
// (`hasLongWindowMarker`/`stripLongWindowMarker`) e il formattatore
// (`formatContextWindow`) si prendono da `shared/context-window`: è dove sono
// dichiarati ed è già da lì che li importa chi li usa davvero (la UI del picker).
export { DEFAULT_CONTEXT_WINDOW } from "../../shared/context-thresholds";
export { contextWindowFor, windowCoveringMeasure, windowModelFor } from "../../shared/context-window";
export type { ContextWindow } from "../../shared/context-window";

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
 * Se il modello non è in tabella si tiene la finestra registrata con la misura.
 *
 * LIMITE NOTO, dichiarato perché non si può dedurre: quando il modello È in
 * tabella, la nostra voce vince anche su una finestra DICHIARATA dal provider
 * (Codex manda `model_context_window`). `session_context` non distingue
 * "dichiarata" da "dedotta" — ha solo `estimated`, che vuol dire "il modello non
 * era in tabella" — quindi qui non c'è modo di sapere quale delle due è. Sintomo:
 * su una sessione Codex l'evento vivo mostra la finestra del provider e una
 * rilettura dopo un reload mostra la nostra, con due percentuali diverse sulla
 * stessa misura.
 *
 * NON si risolve con un'euristica del tipo "se differisce allora era dichiarata":
 * quando la tabella si corregge — com'è appena successo passando Sonnet 5 da 200k
 * a 1M — tutte le righe vecchie differiscono, e verrebbero prese per dichiarate
 * riportando indietro proprio il bug che il ricalcolo esiste per chiudere. Serve
 * una colonna che registri l'origine del denominatore; finché non c'è, la tabella
 * vince e questo commento è il posto dove è scritto.
 *
 * Qualunque strada prenda, il risultato passa da `windowCoveringMeasure`: se il
 * contesto misurato non ci sta nella finestra che abbiamo risolto, la finestra è
 * sbagliata e la misura ha ragione — quella chiamata ha ricevuto risposta. È
 * l'ultima rete, quella che tiene anche quando il nome del modello si perde per
 * strada (pin vuoto + nome nudo negli eventi della CLI = 288% sul ring).
 */
export function windowForMeasure(
  measure: { model: string | null; windowTokens: number; estimated: boolean; usedTokens: number },
  currentModel: string | null | undefined,
): ContextWindow {
  // Il modello del TOPIC vince, e non è la stessa scelta di `windowModelFor`.
  // Quella funzione è retrospettiva: «la CLI ha risposto con X mentre chiedevo Y,
  // quale finestra ha dimensionato QUEL turno». Qui la domanda è opposta —
  // «contro cosa va letto questo contesto ADESSO» — e la risposta è il modello
  // che servirà il turno successivo, perché è lui che dovrà reggere questi token.
  // È anche il ramo che recupera il suffisso `[1m]`: la misura porta il nome nudo
  // che la CLI riporta nei suoi eventi, il topic porta la modalità scelta.
  const covering = (window: ContextWindow, model: string | null | undefined) =>
    windowCoveringMeasure(window, model, measure.usedTokens);
  if (currentModel) {
    const current = contextWindowFor(currentModel);
    if (current.known) return covering(current, currentModel);
  }
  const fromMeasure = contextWindowFor(measure.model);
  if (fromMeasure.known) return covering(fromMeasure, measure.model);
  return covering(
    { tokens: measure.windowTokens, known: !measure.estimated },
    currentModel ?? measure.model,
  );
}

// Le soglie e la funzione di livello vivono in `shared/context-thresholds.ts`:
// il client le disegna, il server le classifica, e quando stavano solo qui il
// client le riscriveva a mano con `>` invece di `>=`. Ri-esportate perché i
// chiamanti storici le importano da questo modulo — e SOLO quelle: le due
// soglie in TOKEN si prendono da `shared/context-thresholds`, dove sono
// dichiarate ed è già da lì che le importa chi le usa.
export {
  CONTEXT_WARN_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
  contextLevel,
} from "../../shared/context-thresholds";
export type { ContextLevel } from "../../shared/context-thresholds";

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
  // Il motivo è la soglia che ha prodotto il LIVELLO, non la prima che è scattata.
  // Confrontare «percent >= WARN» come faceva la prima versione sbagliava proprio
  // nella fascia che conta: a 700k su 1M la capienza è solo a `warn` mentre il
  // costo è già `critical`, e il messaggio usciva «Context almost full — 70%» in
  // rosso, con trecentomila token liberi. A pari severità vince la capienza:
  // «la finestra sta finendo» è più urgente di «costa molto per chiamata».
  const byPercent = levelFromPercent(percent);
  const byTokens = levelFromTokens(safeUsed);
  const level = worseLevel(byPercent, byTokens);
  const reason: ContextReason | undefined =
    level === "ok" ? undefined : LEVEL_RANK[byPercent] >= LEVEL_RANK[byTokens] ? "window" : "cost";
  return { used: safeUsed, size, percent, level, ...(reason ? { reason } : {}), estimated: !window.known };
}

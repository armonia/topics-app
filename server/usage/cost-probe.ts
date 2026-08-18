/**
 * La sonda del costo: contesto × chiamate, non il totale a fine sessione.
 *
 * PERCHÉ ESISTE. Il costo di una chat non è quanto si è parlato: è quanto
 * contesto ha in pancia il modello MOLTIPLICATO per quante volte glielo si
 * rispedisce. Ogni chiamata a un tool è una chiamata al modello, e ogni
 * chiamata al modello rilegge tutto: una pagina fetchata al terzo turno la si
 * ripaga a ogni chiamata fino alla fine della sessione.
 *
 * I due fattori esistevano già, separati e muti: `session_context` teneva il
 * contesto (il ring), `messages.tool_calls` teneva le chiamate (sepolte in un
 * tooltip). Nessuno li moltiplicava, quindi il numero che decide la spesa —
 * «con 320k in pancia, ogni chiamata costa 320k» — non era da nessuna parte, e
 * ci si accorgeva del conto quando era già speso.
 *
 * DUE NUMERI, NON UNO. La sonda riporta insieme:
 *  • `projected` = contesto di ADESSO × chiamate. È la proiezione: quanto
 *    sarebbero costate quelle chiamate se il contesto fosse sempre stato quello
 *    di oggi. È il numero che si può prevedere, ed è quello che serve per
 *    decidere prima di spendere;
 *  • `promptTokens` = quanto è stato spedito DAVVERO, sommando le misure.
 * `projected` è sempre più grande di `measured` per un motivo solo, ed è la
 * ragione per cui vanno letti insieme: il contesto CRESCEVA. Il loro rapporto
 * dice quanto è cresciuto. Mostrarne uno solo trasformerebbe una previsione in
 * un consuntivo sbagliato, o viceversa.
 *
 * PURA, dove può esserlo: `computeCostProbe` non tocca il database, così i
 * numeri si possono pinnare su righe finte in un test unitario. Il lettore SQL
 * (`probeSessionCost`) è una riga di traduzione sopra.
 */

import type { Database } from "bun:sqlite";
import { getSessionContext } from "../db/session-context";
import { calculateCostWithCache } from "./pricing";
import { contextWindowFor, windowCoveringMeasure } from "./context-window";
import { decodeCol } from "../../shared/message-blob";

/** Un messaggio, ridotto ai soli fatti che parlano di costo. */
export interface CostProbeRow {
  role: "user" | "assistant";
  /** `input + cache_read + cache_creation` di TUTTE le chiamate del turno. */
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costCents: number;
  model: string | null;
  /**
   * Il contesto misurato al momento di OGNI chiamata a tool del turno, in
   * ordine. `null` = quella chiamata non porta la misura (l'ultimo blocco di un
   * turno spesso non ce l'ha): conta come chiamata, non come misura.
   */
  callTokens: Array<number | null>;
}

/**
 * La forma che esce da qui vive in `shared/types.ts`, non qui: è il corpo di
 * `GET /api/context/cost`, cioè un contratto col client, e il client non può
 * importare da `server/` (TS6307). Tenerla di là è ciò che impedisce a una
 * seconda copia di nascere nei tipi del client e di divergere sul primo campo
 * aggiunto — stessa regola di `AcpUsageUpdate` in `usage-update.ts`.
 */
export type { SessionCostProbe as CostProbe } from "../../shared/types";
import type { SessionCostProbe as CostProbe, TurnCostProbe as TurnCost } from "../../shared/types";

/** Numero utilizzabile, o 0. */
function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Il contesto corrente = l'ULTIMA misura per chiamata che esiste nella sessione.
 *
 * L'ultima e non la più grande: il contesto può SCENDERE (una compattazione lo
 * dimezza), e il massimo storico continuerebbe a fatturare un prompt che non
 * viaggia più. Se nessuna chiamata porta la misura resta il fallback — la riga
 * di `session_context`, che è la stessa cosa scritta da un'altra porta.
 */
function lastMeasuredContext(rows: CostProbeRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const calls = rows[i].callTokens;
    for (let j = calls.length - 1; j >= 0; j--) {
      const t = n(calls[j]);
      if (t > 0) return t;
    }
  }
  return 0;
}

/**
 * Il costo di UNA chiamata in più, in dollari.
 *
 * Tariffata come rilettura di cache, che è ciò che succede davvero: in una
 * sessione lunga la quasi totalità del prompt è lo stesso contesto già visto
 * (26,8M su 27,7M nella chat di riferimento). Prezzarla a token freschi
 * gonfierebbe di 10× il numero che deve far decidere.
 */
function priceOneCall(model: string | null, contextTokens: number): number {
  if (!model || contextTokens <= 0) return 0;
  return calculateCostWithCache({
    model,
    freshInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: contextTokens,
  });
}

/**
 * Le righe → la sonda. `fallback` è l'ultima misura persistita
 * (`session_context`): serve quando le chiamate non portano token propri, o
 * quando il turno vivo ha già mosso il contesto oltre l'ultimo messaggio scritto.
 */
export function computeCostProbe(
  rows: CostProbeRow[],
  fallback?: { usedTokens?: number; windowTokens?: number; model?: string | null } | null,
): CostProbe {
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costCents = 0;
  let lastAssistant: CostProbeRow | null = null;

  for (const r of rows) {
    toolCalls += r.callTokens.length;
    promptTokens += n(r.promptTokens);
    completionTokens += n(r.completionTokens);
    costCents += n(r.costCents);
    // L'ultimo turno è l'ultimo messaggio dell'assistente che ha davvero
    // chiamato il modello: una risposta a costo zero (un errore, un turno
    // interrotto prima della prima chiamata) non è un turno di cui misurare il
    // moltiplicatore, ed eleggerla azzererebbe la riga proprio dopo un turno caro.
    if (r.role === "assistant" && (r.callTokens.length > 0 || n(r.promptTokens) > 0)) lastAssistant = r;
  }

  const measured = lastMeasuredContext(rows);
  // La misura persistita vince quando è PIÙ RECENTE, ed è il caso del turno in
  // corso: `session_context` viene riscritta a ogni chiamata, la riga del
  // messaggio solo a turno chiuso. Non "la più grande": se una compattazione ha
  // abbassato il contesto, il numero giusto è quello nuovo, e arriva da qui.
  const contextTokens = n(fallback?.usedTokens) || measured;
  const model = lastAssistant?.model ?? fallback?.model ?? null;

  const lastTurn: TurnCost | null = lastAssistant
    ? (() => {
        const turnContext = lastMeasuredContext([lastAssistant]) || contextTokens;
        const calls = lastAssistant.callTokens.length;
        return {
          toolCalls: calls,
          contextTokens: turnContext,
          projectedTokens: turnContext * calls,
          promptTokens: n(lastAssistant.promptTokens),
          completionTokens: n(lastAssistant.completionTokens),
          costUsd: n(lastAssistant.costCents) / 100,
        };
      })()
    : null;

  // Il denominatore: quello persistito se c'è, altrimenti la tabella delle
  // finestre — e mai più piccolo della misura, perché un prompt che ha ricevuto
  // risposta non può essere più grande della finestra che l'ha servito (stessa
  // regola di `buildContextUpdate`, vedi usage-update.ts).
  const windowTokens = windowCoveringMeasure(
    n(fallback?.windowTokens) > 0 ? { tokens: n(fallback?.windowTokens), known: true } : contextWindowFor(model),
    model,
    contextTokens,
  ).tokens;

  return {
    contextTokens,
    windowTokens,
    perCallUsd: priceOneCall(model, contextTokens),
    toolCalls,
    projectedTokens: contextTokens * toolCalls,
    promptTokens,
    completionTokens,
    costUsd: costCents / 100,
    messages: rows.length,
    model,
    lastTurn,
  };
}

/** Le righe della sessione, in ordine di conversazione. */
export function readCostProbeRows(
  db: Database,
  sessionKey: string,
  opts?: { limitMessages?: number },
): CostProbeRow[] {
  // `LIMIT` sul prefisso e non un `WHERE` sul tempo: il taglio serve al test
  // della BARRA, che deve rileggere una chat REALE com'era ai primi N messaggi
  // — la stessa chat è cresciuta da allora, e un prefisso è l'unico modo di
  // confrontarsi con una misura presa in un momento che non torna più.
  const limit = opts?.limitMessages && opts.limitMessages > 0 ? opts.limitMessages : -1;
  const raw = db
    .prepare(
      `SELECT role, tool_calls, usage_prompt_tokens, usage_completion_tokens,
              cache_read_tokens, cache_creation_tokens, cost_cents, model
         FROM messages
        WHERE session_key = ?
        ORDER BY sort_order, timestamp
        LIMIT ?`,
    )
    .all(sessionKey, limit) as Array<Record<string, unknown>>;

  return raw.map((r) => ({
    role: r.role === "assistant" ? "assistant" : "user",
    promptTokens: n(r.usage_prompt_tokens),
    completionTokens: n(r.usage_completion_tokens),
    cacheReadTokens: n(r.cache_read_tokens),
    cacheCreationTokens: n(r.cache_creation_tokens),
    costCents: n(r.cost_cents),
    model: r.model != null ? String(r.model) : null,
    callTokens: parseCallTokens(decodeCol(r.tool_calls)),
  }));
}

/**
 * `tool_calls` (JSON) → i token per chiamata, in ordine.
 *
 * Best-effort per scelta: una riga con JSON storto vale zero chiamate, non un
 * errore. La sonda è un'informazione; una sonda che lancia spegnerebbe la
 * pagina in cui vive.
 */
function parseCallTokens(raw: unknown): Array<number | null> {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((c) => {
      const t = c && typeof c === "object" ? (c as { tokens?: unknown }).tokens : undefined;
      return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
    });
  } catch {
    return [];
  }
}

/** La sonda per una sessione, letta dal database. */
export function probeSessionCost(
  db: Database,
  sessionKey: string,
  opts?: { limitMessages?: number },
): CostProbe {
  const rows = readCostProbeRows(db, sessionKey, opts);
  // Sul PREFISSO la misura persistita non vale: `session_context` tiene il
  // contesto di ADESSO, che è quello dopo l'ultimo messaggio della chat, non
  // dopo l'N-esimo. Usarla farebbe passare il test con un numero preso da fuori
  // dalla finestra che si sta misurando.
  const live = opts?.limitMessages ? null : getSessionContext(db, sessionKey);
  return computeCostProbe(rows, live ? { usedTokens: live.usedTokens, windowTokens: live.windowTokens, model: live.model } : null);
}

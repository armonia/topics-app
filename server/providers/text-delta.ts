/**
 * Da testo CUMULATIVO a DELTA — una volta sola, nel provider che è cumulativo.
 *
 * `StreamHandler.onTextDelta(text, fullText)` è sempre stato "il pezzo nuovo,
 * più il cumulato", e quattro provider su cinque lo rispettano: claude.ts,
 * openai.ts, codex.ts e claude-code.ts passano tutti il pezzo. Solo il gateway
 * OpenClaw (`gateway-ws.ts`) mandava il messaggio INTERO a ogni evento `delta`.
 *
 * La route compensava a valle indovinando: se il testo cominciava per quello di
 * prima ne tagliava il prefisso, e se era IDENTICO lo scartava come "niente di
 * nuovo". Su un provider a delta veri quella seconda regola è una perdita di
 * dati silenziosa — due token uguali di fila («the the», «= =», un `\n` dopo un
 * `\n`) e il secondo spariva dalla risposta. La prima regola sbagliava a sua
 * volta: un delta che per caso comincia col delta precedente («ab» dopo «a»)
 * veniva accorciato.
 *
 * Quindi la normalizzazione sta QUI, e la applica solo chi è cumulativo. La
 * route riceve delta da tutti e li appende senza interpretarli.
 */

export interface TextDeltaStep {
  /** Il pezzo NUOVO da appendere. Stringa vuota = niente da fare. */
  delta: string;
  /** Il nuovo cumulato, da ripassare come `prev` alla chiamata successiva. */
  cumulative: string;
}

/**
 * Il pezzo nuovo di un flusso CUMULATIVO, dato il cumulato precedente.
 *
 * `incoming` è il testo intero visto finora secondo il mittente. Normalmente
 * estende `prev`, e il delta è la coda. I due casi degeneri hanno una risposta
 * sola: non inventare.
 *
 * - `incoming` identico a `prev` → nessun pezzo nuovo (una ripetizione di un
 *   flusso cumulativo È «niente di nuovo», al contrario di un flusso a delta).
 * - `incoming` NON estende `prev` (il mittente ha riscritto il messaggio: una
 *   correzione, un replay dopo riconnessione) → si riparte da `incoming`
 *   intero. Tagliarlo su un prefisso che non c'è produrrebbe testo mutilato;
 *   ripeterlo è visibile e recuperabile, perderlo no.
 */
export function nextTextDelta(prev: string, incoming: string): TextDeltaStep {
  if (incoming === prev) return { delta: "", cumulative: prev };
  if (prev && incoming.startsWith(prev)) {
    return { delta: incoming.slice(prev.length), cumulative: incoming };
  }
  return { delta: incoming, cumulative: incoming };
}

/**
 * QUANTO HA CONSUMATO UNA SESSIONE DEL RUNTIME NATIVO.
 *
 * ── Il buco che chiude ──────────────────────────────────────────────────────
 * `getSessionUsage` legge i TRANSCRIPT JSONL di Claude Code. Il runtime nativo
 * (`provider: topics`) gira in processo e non scrive nessun JSONL: il lettore
 * cerca un file che non esiste e risponde zero. Misurato il 18/08 sul DB vivo:
 * 43 card con `agent_ms > 0` e `agent_tokens = 0`, cioe' tutte quelle lavorate
 * dal nativo — da qui in avanti tutte. Il costo di ogni card era invisibile.
 *
 * Il numero c'era gia': `runAgentTurn` lo misura e lo restituisce. A mancare era
 * il posto dove depositarlo. Questo e' quel posto, ed e' il gemello di
 * `turn-end-registry.ts` — stessa ragione («chi lo SA e chi lo usa sono separati
 * da una route HTTP»), stesso tetto, stesso sfratto del piu' vecchio.
 *
 * ── UNA DIFFERENZA CHE CONTA: qui si ACCUMULA, non si consuma ───────────────
 * `takeTurnEnd` consuma apposta: la ragione di un turno letta due volte sarebbe
 * attribuita a un turno nuovo. L'uso e' l'opposto — `tasks.agent_tokens` porta
 * il TOTALE della sessione, non l'ultimo turno, e il dispatcher lo rilegge ogni
 * quattro secondi per il ticker. Un registro che consuma darebbe zero alla
 * seconda lettura e il contatore crollerebbe a meta' turno.
 *
 * E per la stessa ragione il totale non si azzera fra un turno e l'altro: chi
 * chiama vede la somma di tutti i turni di quella sessione, come farebbe
 * rileggendo un transcript dall'inizio.
 *
 * ── La forma e' quella del lettore dei transcript, non una nuova ────────────
 * `billableTokens` = input + output + cacheWrite tiene la semantica storica
 * (cosi' il chip della board resta confrontabile turno su turno) e `cacheRead`
 * viaggia a parte per il dettaglio. Divergere qui vorrebbe dire due unita' di
 * misura sulla stessa colonna.
 */

import { ZERO_USAGE, type SessionUsage } from "../services/transcript-usage";

/** L'uso di UN turno, come lo misura `runAgentTurn`. */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Quota di `cacheWrite` a TTL un'ora: sottoinsieme, non addendo. */
  cacheWrite1h: number;
}

/**
 * Stesso tetto del registro gemello e per lo stesso motivo: le sessioni di chat
 * non vengono mai ritirate, e senza tetto la mappa crescerebbe di una riga per
 * ogni chat mai piu' riaperta.
 */
const MAX_ENTRIES = 200;

const totals = new Map<string, SessionUsage>();

/** Somma l'uso di un turno al totale della sua sessione. */
export function recordTurnUsage(sessionKey: string, turn: TurnUsage): void {
  if (!sessionKey) return;
  const prev = totals.get(sessionKey) ?? ZERO_USAGE;
  const next: SessionUsage = {
    inputTokens: prev.inputTokens + (turn.input || 0),
    outputTokens: prev.outputTokens + (turn.output || 0),
    cacheWriteTokens: prev.cacheWriteTokens + (turn.cacheWrite || 0),
    cacheWrite1hTokens: prev.cacheWrite1hTokens + (turn.cacheWrite1h || 0),
    cacheReadTokens: prev.cacheReadTokens + (turn.cacheRead || 0),
    billableTokens: 0,
  };
  // Derivato, mai sommato dal chiamante: un `billableTokens` passato da fuori
  // potrebbe non corrispondere ai suoi addendi, e allora la colonna e il
  // dettaglio racconterebbero due storie.
  next.billableTokens = next.inputTokens + next.outputTokens + next.cacheWriteTokens;
  // delete+set rimette la chiave in coda all'ordine d'inserimento: lo sfratto
  // colpisce la sessione ferma da piu' tempo.
  totals.delete(sessionKey);
  totals.set(sessionKey, next);
  while (totals.size > MAX_ENTRIES) {
    const oldest = totals.keys().next();
    if (oldest.done) break;
    totals.delete(oldest.value);
  }
}

/**
 * Il totale della sessione, oppure `null` se il nativo non ha mai girato qui.
 *
 * `null` e non `ZERO_USAGE`: sono due risposte diverse. «Non lo so» deve poter
 * cadere sul lettore dei transcript (una sessione CLI), mentre uno zero
 * direbbe «misurato: non ha consumato niente» e spegnerebbe quel ripiego.
 */
export function readNativeUsage(sessionKey: string): SessionUsage | null {
  return totals.get(sessionKey) ?? null;
}

/** Solo per i test: il registro vive quanto il processo. */
export function resetNativeUsage(): void {
  totals.clear();
}

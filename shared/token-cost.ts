/**
 * UNA sola definizione di «token», scritta come decisione.
 *
 * Ce n'erano tre, tutte chiamate token, e i loro numeri non si somigliavano:
 *
 *  · la CARD di un task mostrava `agent_tokens`, cioè input+output+scrittura di
 *    cache, e lasciava fuori la RILETTURA di cache — che è la quota dominante
 *    del consumo reale (~60% misurato). Il chip diceva circa il 2,8% dei token
 *    davvero passati;
 *  · la DASHBOARD e il profilo sommavano le due colonne intere
 *    (`usage_prompt_tokens + usage_completion_tokens`), cioè la rilettura a
 *    prezzo PIENO;
 *  · il piede di un messaggio in chat faceva la stessa somma della dashboard.
 *
 * Sui dati veri lo scarto fra la prima e le altre è 34,7×. Due numeri diversi
 * nella stessa app sono il modo in cui nessuno dei due viene creduto.
 *
 * LA DECISIONE: il numero che si mostra è QUANTO È COSTATO.
 *
 * Un token riletto dalla cache costa circa un decimo di un token fresco, ed è
 * per questo che pesa 0,1 invece di 1 o di 0. Chi guarda una card decide se una
 * cosa è costata troppo, non quanta memoria ha attraversato il modello.
 *
 * «Quanto contesto è passato» resta una domanda legittima e ha la sua funzione
 * (`contextTokens`): vive nel tooltip, che è il posto del dettaglio.
 *
 * Le colonne restano le PARTI e non si riscrivono: nessuna migration. Le due
 * tabelle le scompongono in modo diverso — `messages.usage_prompt_tokens`
 * CONTIENE già la rilettura, `tasks.agent_tokens` no — quindi chi legge una
 * riga la porta a questa forma prima di chiedere il conto.
 */

/** Quanto pesa un token riletto dalla cache rispetto a uno fresco. */
export const CACHE_READ_WEIGHT = 0.1;

/** Le due parti da cui nascono entrambe le domande. */
export interface TokenParts {
  /** Input + output + scrittura di cache: i token pagati a prezzo pieno. */
  billable: number;
  /** Rilettura di cache: pagata circa un decimo. */
  cacheRead: number;
}

const n = (v: number | null | undefined): number => (Number.isFinite(v) ? Math.max(0, v as number) : 0);

/**
 * QUANTO È COSTATO, in token equivalenti. È il numero che va su una card, su un
 * grafico, nel piede di un messaggio: ovunque si stia decidendo se una cosa è
 * costata troppo.
 */
export function costTokens(parts: Partial<TokenParts> | null | undefined): number {
  if (!parts) return 0;
  return Math.round(n(parts.billable) + CACHE_READ_WEIGHT * n(parts.cacheRead));
}

/**
 * QUANTO CONTESTO È PASSATO. Domanda diversa e risposta diversa: qui la
 * rilettura vale uno, perché la domanda è quanta roba ha attraversato il
 * modello, non quanto è stata pagata.
 */
export function contextTokens(parts: Partial<TokenParts> | null | undefined): number {
  if (!parts) return 0;
  return Math.round(n(parts.billable) + n(parts.cacheRead));
}

/**
 * Le parti come le scompone la riga di un MESSAGGIO: `usage_prompt_tokens`
 * contiene già la rilettura, quindi la quota fatturabile si ottiene
 * sottraendola. Il `max(0, …)` non è una cintura: su righe vecchie la
 * rilettura può essere stata scritta senza che il prompt la contenesse, e un
 * numero negativo qui diventerebbe uno sconto.
 */
export function partsFromMessage(row: {
  usagePromptTokens?: number | null;
  usageCompletionTokens?: number | null;
  cacheReadTokens?: number | null;
}): TokenParts {
  const cacheRead = n(row.cacheReadTokens);
  const prompt = n(row.usagePromptTokens);
  return {
    billable: Math.max(0, prompt - cacheRead) + n(row.usageCompletionTokens),
    cacheRead,
  };
}

/** Le parti come le scompone la riga di un TASK: già separate, niente da togliere. */
export function partsFromTask(row: {
  agentTokens?: number | null;
  agentCacheReadTokens?: number | null;
}): TokenParts {
  return { billable: n(row.agentTokens), cacheRead: n(row.agentCacheReadTokens) };
}

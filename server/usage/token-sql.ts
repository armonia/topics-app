import { CACHE_READ_WEIGHT } from "../../shared/token-cost";

/**
 * La stessa definizione di `shared/token-cost.ts`, ma scritta in SQL.
 *
 * Esiste perché una query che aggrega per giorno non può chiamare una funzione
 * TypeScript riga per riga, e riscrivere la formula dentro la query sarebbe la
 * quarta copia — cioè il modo esatto in cui erano nate le tre definizioni che
 * questo lavoro ha unificato. Il PESO viene da lì (`CACHE_READ_WEIGHT`): se
 * cambia, cambia in un posto solo e queste stringhe lo seguono.
 *
 * Le due tabelle scompongono le stesse quantità in modo diverso, ed è tutta la
 * ragione per cui servono due stringhe invece di una:
 *
 *  · `messages.usage_prompt_tokens` CONTIENE già la rilettura di cache, quindi
 *    la quota fatturabile si ottiene sottraendola. Il `MAX(0, …)` non è una
 *    cintura: su righe vecchie la rilettura può essere stata scritta senza che
 *    il prompt la contenesse, e un numero negativo qui diventerebbe uno sconto.
 *  · `tasks.agent_tokens` la rilettura non ce l'ha: sta nella sua colonna.
 */

/** Il costo in token equivalenti di una riga di `messages`. */
export const costFromMessage =
  `(MAX(0, COALESCE(usage_prompt_tokens, 0) - COALESCE(cache_read_tokens, 0))` +
  ` + COALESCE(usage_completion_tokens, 0)` +
  ` + ${CACHE_READ_WEIGHT} * COALESCE(cache_read_tokens, 0))`;

/** Il costo in token equivalenti di una riga di `tasks`. */
export const costFromTask =
  `(COALESCE(agent_tokens, 0) + ${CACHE_READ_WEIGHT} * COALESCE(agent_cache_read_tokens, 0))`;


// Il silenziatore dei topic di board: quali segnali di un topic che sta
// LAVORANDO un task dispatchato meritano un banner all'umano, e quali no.
//
// Il guasto: una consegna sola produceva tre banner OS.
//   1. `task:review-ready` → «Task pronto per la review: <titolo>»
//   2. fine turno → `session:state` fase `awaiting-user` → «<nome topic>: In
//      attesa di te» — e il nome del topic È il testo del task
//      (`task-dispatcher.ts`: `name: task.text.slice(0, 60)`), quindi i due
//      banner si leggono quasi identici;
//   3. a finestra nascosta, il messaggio dell'assistente → `message:new` in
//      `usePanelLifecycle` → un terzo banner con lo stesso titolo.
//
// La tentazione è collassarli su una chiave di cooldown condivisa. Sarebbe
// sbagliato: nella consegna DI SISTEMA l'ordine è invertito — la fase
// `awaiting-user` arriva PRIMA e `task:review-ready` DOPO (task-dispatcher:
// `onTurnEnd` → `deliverToReviewBySystem`) — quindi una finestra comune da 10s
// mangerebbe proprio il banner di review, cioè il caso che prima era silenzioso
// e che si è aggiunto apposta. Serve una precedenza a senso unico, non un
// collasso simmetrico: mentre un agente di board lavora, la fine di un SUO
// turno non è un evento per l'umano (o il dispatcher rilancia, o arriva
// `task:review-ready`); restano azionabili l'approvazione e l'errore.

import { isAgentWorking } from '../board';
import type { ClaudeSessionPhase } from '../../types';

/**
 * Le fasi che, mentre l'agente di board lavora, sono RUMORE: la fine di un
 * turno. `awaiting-approval` ed `error` non ci sono di proposito — un permesso
 * da concedere e una sessione morta richiedono l'umano subito, dispatch o no.
 */
const AGENT_TURN_NOISE: ReadonlySet<ClaudeSessionPhase> = new Set([
  'awaiting-user',
  'completed',
]);

/**
 * True se questa transizione di fase va SOPPRESSA perché è la fine turno di un
 * agente di board al lavoro.
 *
 * `dispatchState` è quello del task legato al topic (null/undefined = nessun
 * task, o task fermo): fuori dagli stati attivi il topic è tornato una chat
 * umana come le altre e va bannerizzato normalmente — sopprimere sulla sola
 * esistenza di un `assignedTopicId` zittirebbe per sempre ogni topic ex-task.
 */
export function isAgentTurnNoise(
  phase: ClaudeSessionPhase,
  dispatchState: string | null | undefined,
): boolean {
  if (!isAgentWorking(dispatchState)) return false;
  return AGENT_TURN_NOISE.has(phase);
}

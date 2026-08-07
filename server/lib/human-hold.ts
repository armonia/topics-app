/**
 * «Questo turno sta aspettando una PERSONA» — la porta unica.
 *
 * Ci sono due modi in cui un turno resta zitto per un motivo legittimo:
 *
 *   1. una domanda a schermo (`mcp__topics__ask_user_question`);
 *   2. una richiesta di PERMESSO a schermo (`--permission-prompt-tool`).
 *
 * Sono lo stesso fatto per chiunque guardi da fuori: il figlio CLI è bloccato
 * sulla risposta JSON-RPC del bridge e per costruzione non produce un byte
 * finché non si preme. E sono SEI i posti che devono saperlo — il tetto di vita
 * del figlio, il reaper d'inattività, lo spazzino degli stream fermi, lo
 * snapshot, l'abort, la fine del turno.
 *
 * Questo modulo esiste perché quei sei posti interroghino UNA cosa sola. La
 * seconda sorgente di silenzio legittimo è arrivata dopo la prima: se ognuno di
 * quei sei avesse dovuto imparare a chiedere anche a lei, il difetto non
 * sarebbe stato un errore di compilazione ma un turno ucciso sotto un pannello
 * aperto — cioè esattamente il guasto che quelle esenzioni esistono per evitare,
 * ricomparso in uno solo dei sei rami e quindi «a caso».
 *
 * Chi ha bisogno di distinguere i due casi (la rotta delle risposte, che deve
 * sapere DOVE mandare un click) importa il modulo specifico. Chi ha bisogno di
 * sapere solo «c'è una persona in mezzo?» importa questo.
 */

import { hasPendingAsk, pendingAskAgeMs, cancelAsk } from './ask-user-bridge';
import {
  sessionHasPendingPermission,
  pendingPermissionAgeMs,
  cancelPermissionsForSession,
} from './permission-bridge';

/** C'è una domanda o una richiesta di permesso a schermo per questa sessione? */
export function isHumanHold(sessionKey: string): boolean {
  return hasPendingAsk(sessionKey) || sessionHasPendingPermission(sessionKey);
}

/**
 * Da quanto si aspetta la persona, contando dalla cosa aperta da PIÙ tempo, o
 * `null` se non si aspetta nessuno. Il massimo e non il minimo: l'esenzione va
 * misurata sull'attesa più lunga, altrimenti una richiesta appena aperta
 * rimetterebbe a zero l'orologio di una vecchia e l'esenzione non finirebbe mai.
 */
export function humanHoldAgeMs(sessionKey: string, now = Date.now()): number | null {
  const ask = pendingAskAgeMs(sessionKey, now);
  const perm = pendingPermissionAgeMs(sessionKey, now);
  if (ask === null) return perm;
  if (perm === null) return ask;
  return Math.max(ask, perm);
}

/**
 * Sblocca TUTTO ciò che sta aspettando una persona su questa sessione, con un
 * errore leggibile invece del silenzio. Va chiamata dove finisce il motivo per
 * cui si stava aspettando: turno interrotto, turno finito, sessione azzerata.
 */
export function releaseHumanHold(sessionKey: string, reason: string): void {
  cancelAsk(sessionKey, reason);
  cancelPermissionsForSession(sessionKey, reason);
}

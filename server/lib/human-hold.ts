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
  pendingPermissionAgeMs,
  cancelPermissionsForSession,
  PERMISSION_TTL_MS,
} from './permission-bridge';

/**
 * C'è una domanda o un permesso a schermo per questa sessione?
 *
 * ── Perché il permesso è LIMITATO nel tempo e la domanda no ─────────────────
 * Questo predicato disarma watchdog, reaper e tetto di vita: dice «il silenzio
 * è legittimo, non toccare». Per una domanda quel disarmo è senza scadenza di
 * proposito — chi lascia il computer alle sei e risponde la mattina dopo deve
 * ritrovare il pannello vivo (vedi la nota su `DEFAULT_ASK_TTL_MS`).
 *
 * Per un permesso no, e il motivo è la forma di come muore. Le richieste vivono
 * in memoria e si chiudono da sole solo quando il bridge torna a pollare: se il
 * figlio CLI muore SOTTO un pannello aperto, nessuna gamba arriva più, niente
 * scade, e questa funzione giurerebbe per sempre che una persona sta per
 * rispondere — su una sessione dove non c'è più nessuno da aspettare. È il
 * fantasma visto il 7 agosto: tre chiamate ferme e un pannello che invitava un
 * click che non poteva arrivare da nessuna parte.
 *
 * Quindi il permesso vale come attesa finché è dentro il suo TTL, e non un
 * minuto di più. Non è un modo per negare in fretta: due ore sono oltre
 * qualunque attesa reale davanti a tre bottoni, e scaduto il tetto le reti di
 * sicurezza tornano ad avere i denti invece di restare disarmate a vuoto.
 */
export function isHumanHold(sessionKey: string, now = Date.now()): boolean {
  if (hasPendingAsk(sessionKey)) return true;
  const perm = pendingPermissionAgeMs(sessionKey, now);
  return perm !== null && perm < PERMISSION_TTL_MS;
}

/**
 * Da quanto si aspetta la persona, contando dalla cosa aperta da PIÙ tempo, o
 * `null` se non si aspetta nessuno. Il massimo e non il minimo: l'esenzione va
 * misurata sull'attesa più lunga, altrimenti una richiesta appena aperta
 * rimetterebbe a zero l'orologio di una vecchia e l'esenzione non finirebbe mai.
 */
export function humanHoldAgeMs(sessionKey: string, now = Date.now()): number | null {
  const ask = pendingAskAgeMs(sessionKey, now);
  // Stesso tetto di `isHumanHold`: un permesso scaduto non è più un'attesa, e
  // continuare a contarne l'età terrebbe la chat su «aspetta te» in sidebar
  // sopra un turno che non esiste più.
  const permRaw = pendingPermissionAgeMs(sessionKey, now);
  const perm = permRaw !== null && permRaw < PERMISSION_TTL_MS ? permRaw : null;
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

/**
 * «Passa a libero»: la sessione smette di chiedere, da adesso, senza uscire dal
 * turno.
 *
 * ── Perché non basta cambiare il livello e basta ────────────────────────────
 * `--permission-mode` si decide allo SPAWN (vedi `providers/claude-code.ts`).
 * Il figlio CLI che sta girando in questo momento è nato in `acceptEdits` e in
 * `acceptEdits` resterà fino alla sua morte: qualunque cosa scriviamo sul topic
 * adesso, il prossimo strumento fuori modalità tornerà a chiedere sul canale.
 *
 * Da qui le DUE metà, e servono entrambe:
 *
 *   1. il LIVELLO sul topic (`yolo`) — è ciò che rende la cosa reversibile da
 *      dove si legge, cioè il selettore di autonomia nel composer, e ciò che
 *      farà nascere `bypassPermissions` il prossimo figlio;
 *   2. la GAMBA del permesso che, vedendo una sessione libera, consente senza
 *      aprire nessun pannello — che è come il turno in corso prosegue senza
 *      interruzioni, con il figlio che ha ancora la vecchia modalità.
 *
 * La seconda metà è un guscio sopra la tabella di verità di `autonomy-mode.ts`,
 * non una seconda tabella: «libero» qui vuol dire esattamente «il livello di
 * questa chat mappa su una modalità che non chiede».
 *
 * ── Vale per la SESSIONE ────────────────────────────────────────────────────
 * Il livello vive sul topic, e un topic è una sessione: liberare questa chat non
 * tocca nessun'altra, e non scrive nessuna regola globale. `tool_grants` — che
 * sarebbe stato il posto comodo — vale per tutta l'app e per sempre: usarlo
 * qui avrebbe risposto a una domanda che nessuno ha fatto.
 */

import type { AutonomyLevel, Topic } from '../../shared/types';
import { permissionModeAsks, permissionModeForAutonomy } from './autonomy-mode';

/** Il livello che l'interfaccia chiama «Libero». */
export const FREE_AUTONOMY_LEVEL: AutonomyLevel = 'yolo';

/** I livelli che esistono davvero. Vedi `sessionIsFree` per il perché. */
const KNOWN_LEVELS: readonly AutonomyLevel[] = ['ask', 'auto-apply', 'yolo'];

/**
 * Questa sessione è in modalità libera — cioè: si può consentire senza chiedere?
 *
 * Due condizioni, e la prima non è pignoleria. `permissionModeForAutonomy`
 * riporta al DEFAULT (`bypassPermissions`) qualunque livello non riconosca,
 * perché allo spawn un livello scritto male non deve poter BLOCCARE una chat.
 * Qui la stessa regola si rovescerebbe contro di noi: un livello vuoto o
 * storto diventerebbe «non chiede» — cioè un sì automatico dato per un typo.
 * Quindi si parte dai livelli che esistono, e solo dopo si consulta la tabella.
 * Nel dubbio si CHIEDE: è l'unico verso in cui questo errore è recuperabile.
 */
export function sessionIsFree(level: string | null | undefined): boolean {
  if (!level || !KNOWN_LEVELS.includes(level as AutonomyLevel)) return false;
  return !permissionModeAsks(permissionModeForAutonomy(level));
}

/** Il minimo che serve per liberare una sessione: nessun accesso al DB. */
export interface FreeModeCtx {
  getTopicBySessionKey: (sessionKey: string) => Topic | null;
  saveSingleTopic: (topic: Topic) => void;
  /** Un frame solo, e tipato: questo modulo non ha altri annunci da fare. */
  broadcastToAll: (message: { type: 'topic:updated'; topic: Topic }) => void;
}

export interface FreeModeChange {
  topic: Topic;
  /** Da dove veniva — serve alla riga che si scrive nel thread. */
  previous: AutonomyLevel | null;
  /** `false` quando la sessione era già libera: il gesto resta idempotente. */
  changed: boolean;
}

/**
 * Porta QUESTA sessione in modalità libera e lo annuncia.
 *
 * Il `topic:updated` non è cortesia: è ciò che fa dire «Libero» al selettore nel
 * composer un istante dopo il click, cioè l'unico posto da cui si torna
 * indietro. Un regime che cambia senza che il comando che lo governa se ne
 * accorga è un regime cambiato di nascosto.
 *
 * Torna `null` se la sessione non ha un topic: senza topic non c'è un livello da
 * scrivere, e mentire dicendo «fatto» sarebbe peggio di un errore.
 */
export function switchSessionToFree(ctx: FreeModeCtx, sessionKey: string): FreeModeChange | null {
  const topic = ctx.getTopicBySessionKey(sessionKey);
  if (!topic) return null;
  const previous = topic.autonomyLevel ?? null;
  if (previous === FREE_AUTONOMY_LEVEL) return { topic, previous, changed: false };
  topic.autonomyLevel = FREE_AUTONOMY_LEVEL;
  topic.updatedAt = new Date().toISOString();
  ctx.saveSingleTopic(topic);
  ctx.broadcastToAll({ type: 'topic:updated', topic });
  return { topic, previous, changed: true };
}

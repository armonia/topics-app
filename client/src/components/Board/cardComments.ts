/**
 * Which comments a review card shows: the human request, then the answer.
 *
 * The card used to lead with the LAST non-status comment, whoever wrote it.
 * Commenting a card in review REJECTS it and wakes the agent up again, so a
 * human comment in the thread is almost always a rework request. By the time
 * the task is back in review the last word is the agent's again: the reviewer
 * read the answer with his own request already off the card, and had to
 * remember what he had asked.
 *
 * So the card carries the PAIR when there is one: the human request on top,
 * compressed to one line as context, and the thread's last word below, still
 * the protagonist. When nobody typed anything the card is exactly what it was:
 * no row is reserved and then left blank.
 *
 * The choice lives here, outside the component, because it is the part that can
 * be wrong in silence: any pair renders as a perfectly plausible card.
 */

import { HUMAN_AUTHOR, isMachineNote, isThreadSpeech } from '../../../../shared/board';
import type { BoardTask, CardComment } from '../../lib/board';

export interface CardComments<T extends CardComment = CardComment> {
  /**
   * The thread's last word. The card leads with it, as it always did.
   *
   * Usually the agent. It can also be machine evidence (a `review-note` with
   * the live-preview URL lands exactly when the task enters review), which is
   * why `humanContext` is gated on a real reply existing rather than on this
   * field alone.
   */
  latest: T;
  /** The human request `latest` follows, or null when there is none to quote. */
  humanContext: T | null;
}

/**
 * A comment a PERSON typed on the board.
 *
 * Three conditions, and the third is the one that bites. `author: 'user'` is
 * also the signature the server puts on its own narration when a person pulled
 * the lever: Stop and "archive with a live agent" both go through
 * `release({ by: 'user' })`, which writes the reason into the thread as a plain
 * comment. Without `isMachineNote` the card hands "Fermato da te: agent
 * interrotto." back to you as your own request, on a task where you never typed
 * a word.
 */
export function isHumanComment(comment: CardComment): boolean {
  return comment.author === HUMAN_AUTHOR
    && comment.kind === 'comment'
    && !isMachineNote(comment.content);
}

/**
 * A human comment worth quoting above the answer.
 *
 * Same as `isHumanComment` plus text: an attachment-only comment has nothing to
 * put on that line, and the card must never open a row it then leaves blank.
 */
function isHumanRequest(comment: CardComment): boolean {
  return isHumanComment(comment) && comment.content.trim() !== '';
}

/**
 * Something ANSWERED the request: speech from someone other than the human.
 *
 * `kind` matters. A `review-note` is evidence the machine attached to the
 * delivery, not a reply, and a thread whose only entry after the request is a
 * preview screenshot has nothing that reads as an answer. Quoting the request
 * above it would promise a pair the card cannot deliver.
 */
function isReply(comment: CardComment): boolean {
  return comment.kind === 'comment' && comment.author !== HUMAN_AUTHOR;
}

/**
 * Pick the card's comments, or null when the thread has nothing to say.
 *
 * `kind: 'status'` rows are transition history written on every status change,
 * and `kind: 'service'` rows are the dispatcher's bookkeeping: neither is
 * anybody's word, so both are dropped before anything is decided
 * (`isThreadSpeech`, the same predicate the quick-reply buttons use). Without
 * the second one a queue hold or a restart note written after the agent's answer
 * became the card's `latest`: the card printed "In attesa di uno slot" as the
 * delivery while the buttons underneath still offered the agent's question.
 */
export function selectCardComments<T extends CardComment>(comments: readonly T[]): CardComments<T> | null {
  const speech = comments.filter(isThreadSpeech);
  const latest = speech[speech.length - 1];
  if (!latest) return null;
  // The human spoke last: there is no answer yet, he IS the protagonist, and
  // quoting him above himself would print the same line twice.
  if (isHumanComment(latest)) return { latest, humanContext: null };
  let requestAt = -1;
  for (let i = speech.length - 2; i >= 0; i--) {
    if (isHumanRequest(speech[i]!)) { requestAt = i; break; }
  }
  if (requestAt < 0) return { latest, humanContext: null };
  const answered = speech.slice(requestAt + 1).some(isReply);
  return { latest, humanContext: answered ? speech[requestAt]! : null };
}

/** I campi della riga su cui si decide cosa la card mostra e cosa deve chiedere. */
export type CardThreadRow = Pick<BoardTask, 'status' | 'assignedTopicId' | 'deliveredReason' | 'subtaskCount' | 'recentComments'>;

/**
 * La card ha una PAROLA da mostrare: l'ultima del thread, con i suoi bottoni.
 *
 * Due sorgenti, un solo ramo: l'agente che ha consegnato, e il SISTEMA quando
 * lo stallo dei figli parcheggiati fa la domanda al posto suo (lì la card può
 * non avere nessun topic legato). Fuori dalla review nessuna delle due esiste,
 * ed è per questo che il server attacca `recentComments` solo a quella colonna.
 */
export function showsCardThread(task: CardThreadRow): boolean {
  if (task.status !== 'review') return false;
  // SE IL SERVER LI HA GIA' MANDATI, L'UNICA DOMANDA E' «c'e' qualcosa da
  // leggere?». Prima si pretendeva una sessione agente, e per le card senza
  // — chi lavora dal terminale, chi consegna a mano, chi porta in review
  // scrivendo cos'ha fatto — il thread arrivava fino al browser e finiva in
  // nessun pixel. Misurato sulla board vera il 17/08: 22 card in review, 22
  // con `recentComments` nella risposta, ZERO che li disegnavano. Segnalato
  // due volte: «sembrano solo i task spostati, ma una volta in review dovrei
  // vedere aggiornamenti, no?».
  //
  // `[]` (nessun commento) resta un no: un riquadro vuoto e' peggio del
  // silenzio.
  if (task.recentComments?.length) return true;
  // Il server NON li ha ancora mandati (`undefined` = non lo so ancora): allora
  // vale la vecchia domanda, perche' qui si sta decidendo se CHIEDERLI, e
  // chiederli per ogni card senza thread sarebbe una richiesta a vuoto.
  return task.recentComments === undefined
    && (!!task.assignedTopicId || task.deliveredReason === 'parked_children');
}

/**
 * COSA MANCA ALLA CARD dopo quello che la lista le ha già dato — cioè se deve
 * aprire un `GET /api/tasks/:id` per conto suo.
 *
 * Era una richiesta PER CARD, e il dettaglio non è una riga: si porta dietro
 * l'intero thread del task. Aprendo la board, ogni scheda in review ne
 * sparava una. Adesso i commenti viaggiano con la lista, e resta un solo
 * motivo per chiedere: i sottotask, che nel feed non ci sono
 * (`rootsOnly`) e che la card in review espande come checklist della consegna.
 *
 * `'thread'` è la ricaduta per un server più vecchio del client (il guscio
 * Tauri incorpora il suo `public/` e può restare indietro): senza il campo
 * nuovo la card torna a chiedere, invece di restare muta.
 *
 * La decisione sta QUI e non dentro il componente perché è ciò che il test può
 * eseguire: montare la card vorrebbe dire montare mezza board.
 */
export function cardDetailNeed(task: CardThreadRow): 'none' | 'children' | 'thread' {
  if (showsCardThread(task) && task.recentComments === undefined) return 'thread';
  if (task.status === 'review' && task.subtaskCount > 0) return 'children';
  return 'none';
}

/** I commenti che la card disegna, presi dalla riga della lista. `null` quando
 *  non c'è niente da mostrare o quando il server non li manda. */
export function cardCommentsFromRow(task: CardThreadRow): CardComments | null {
  if (!showsCardThread(task) || !task.recentComments) return null;
  return selectCardComments(task.recentComments);
}

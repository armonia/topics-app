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
import type { TaskComment } from '../../lib/board';

export interface CardComments {
  /**
   * The thread's last word. The card leads with it, as it always did.
   *
   * Usually the agent. It can also be machine evidence (a `review-note` with
   * the live-preview URL lands exactly when the task enters review), which is
   * why `humanContext` is gated on a real reply existing rather than on this
   * field alone.
   */
  latest: TaskComment;
  /** The human request `latest` follows, or null when there is none to quote. */
  humanContext: TaskComment | null;
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
export function isHumanComment(comment: TaskComment): boolean {
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
function isHumanRequest(comment: TaskComment): boolean {
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
function isReply(comment: TaskComment): boolean {
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
export function selectCardComments(comments: readonly TaskComment[]): CardComments | null {
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

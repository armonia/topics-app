/**
 * Is this `stream:end` the clean end of a HUMAN chat turn, the "Claude finished,
 * your turn" fact?
 *
 * One predicate for the two voices that announce it: the reply push on the
 * server (`server/push-triggers.ts`) and the in-page banner on the client
 * (`client/src/lib/notify/chatFinished.ts`). Written twice they would drift, and
 * a drift here means a phone that rings for a turn the desktop keeps quiet about,
 * or the reverse.
 *
 *  · `completed !== true` → an unclean end (error, cancel, the SSE finally): only
 *    a clean finish carries the explicit marker.
 *  · `dispatched`         → a board agent's turn: dozens of them, and not your
 *    chat. The board speaks through `task:review-ready`.
 *  · `reason: user_abort` / `stopCause: watchdog` / `stopReason: cancelled` →
 *    redundant with the marker, kept explicit as a net.
 *  · no `topicId`         → nothing to name, nothing to open.
 */
export interface ChatTurnEnd {
  topicId?: unknown;
  completed?: unknown;
  dispatched?: unknown;
  reason?: unknown;
  stopCause?: unknown;
  stopReason?: unknown;
}

export function isCleanChatTurnEnd(end: ChatTurnEnd): end is ChatTurnEnd & { topicId: string } {
  if (end.completed !== true) return false;
  if (end.dispatched === true) return false;
  if (end.reason === 'user_abort' || end.stopCause === 'watchdog' || end.stopReason === 'cancelled') return false;
  return typeof end.topicId === 'string' && end.topicId.length > 0;
}

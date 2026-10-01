/**
 * Which pane the person is looking at, for the chat and terminal marks.
 *
 * A clean turn end raises the mark (`chatFinishedEdge`), and viewing the chat
 * clears it. When the chat that finished was already in front, the mark used
 * to be raised and then cleared one commit later by the chat pane's effect:
 * short enough to be invisible on the tab, long enough for the provider's
 * effects to paint +1 on the Dock and the PWA badge and take it back, at every
 * turn end (setAppBadge history 0,1,0,1,...; in Tauri two `set_app_status`
 * calls per turn). So the window declares its focused pane here
 * (`useSeenFocusedPane`), and the turn end reads it synchronously and raises
 * no mark at all.
 */
import { signalsActions, useSignalsStore } from './signals';
import { isWindowAwake } from './windowAwake';

/**
 * Chats whose 'done' mark THIS window switched off because the person looked
 * at them, not yet told to the server. The mark lives per window, so the
 * others hear about it only through the chat's seen door, after the dwell
 * (`useWebSocket`): by then the pane has already cleared the mark here, and
 * reading the store at that moment would find nothing. Consumed once.
 */
const chatDoneSeenHere = new Set<string>();

/**
 * The person LOOKED at the chat (its pane in front for the dwell, or the row of
 * a chat held by another window clicked): the mark
 * goes here now, and the seen door tells every other window after the dwell
 * (`takeChatDoneSeen`). A new turn is not a look, and keeps the plain
 * `signalsActions.clearChatFinished`. Before, the clear stayed in this window,
 * and a finished chat with no unread and no notification row kept its mark in
 * every other one.
 */
export function seeChatFinished(topicId: string): void {
  if (!useSignalsStore.getState().chatFinishedTopics.has(topicId)) return;
  chatDoneSeenHere.add(topicId);
  signalsActions.clearChatFinished(topicId);
}

/** Does opening `topicId` here clear a 'done' mark: one seen since the last
 *  call, or one still on it? Consumes the first. */
export function takeChatDoneSeen(topicId: string): boolean {
  const seen = chatDoneSeenHere.delete(topicId);
  return seen || useSignalsStore.getState().chatFinishedTopics.has(topicId);
}

/** Subject id (topic or terminal session) → how many holders declare it the
 *  pane in front of this window (a remount can overlap the release). */
const subjectsInFront = new Map<string, number>();

/** Declare `subjectId` the pane in front of this window until the returned
 *  release runs. The one holder is `useSeenFocusedPane` (paneSeen.ts). */
export function holdSubjectInFront(subjectId: string): () => void {
  subjectsInFront.set(subjectId, (subjectsInFront.get(subjectId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (subjectsInFront.get(subjectId) ?? 1) - 1;
    if (n > 0) subjectsInFront.set(subjectId, n);
    else subjectsInFront.delete(subjectId);
  };
}

/** Is the person looking at this chat or terminal now: it is the window's
 *  focused pane AND the window is awake (`isWindowAwake`, the predicate the
 *  seen dwell reads). A pane focused in a window behind another app is not in
 *  front of anyone. A turn that ends on it raises no mark. */
export function isSubjectInFront(subjectId: string): boolean {
  return (subjectsInFront.get(subjectId) ?? 0) > 0 && isWindowAwake();
}

/**
 * OPEN A TOOL CALL OF THE TRANSCRIPT FROM OUTSIDE IT, AND BRING IT INTO VIEW
 * (chat-strips-in-transcript: a command of the strip opens the card that
 * started it, `SubAgentsStrip`).
 *
 * The opening is the chat find bar's (`chatFindFocus`, CHAT-FIND-02): the
 * turn's fold, the tool group and the row that hold the call open on the edge
 * of that focus. Marked `reveal`, the row also scrolls itself into view once
 * it is open (`ToolCallRow`). A row that is not drawn, its message outside the
 * part of the list Virtuoso renders, needs that message brought into the list
 * first: the palette's jump, once.
 *
 * The focus is dropped a moment later. Left current, a row scrolled out of the
 * list and back would open again and pull the view to itself.
 */
import { getChatFindFocus, setChatFindFocus } from './chatFindFocus';
import { consumeScrollToMessage, requestScrollToMessage } from './scrollToMessage';

/** How long the reveal stays the current focus: the fold, the group and the row have opened well before. */
export const REVEAL_FOCUS_MS = 3000;

export interface RevealTarget {
  topicId: string;
  messageId: string;
  toolCallId: string;
}

/** `within`: the transcript the request comes from, where the row is looked for. */
export function revealToolCall(target: RevealTarget, within: ParentNode): void {
  setChatFindFocus({ ...target, part: 'tool', query: '', matchCase: false, reveal: true });
  const seq = getChatFindFocus()?.seq;
  setTimeout(() => {
    if (getChatFindFocus()?.seq === seq) setChatFindFocus(null);
  }, REVEAL_FOCUS_MS);
  // Two frames: the fold and the group around the row open in the render this focus causes.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (within.querySelector(`[data-testid="tool-call-row-${target.toolCallId}"]`)) return;
    requestScrollToMessage(target.topicId, target.messageId);
    // One jump, without the palette's two seconds of re-centring: those would
    // take the view back from the row as soon as it scrolled itself into place.
    consumeScrollToMessage(target.topicId);
  }));
}

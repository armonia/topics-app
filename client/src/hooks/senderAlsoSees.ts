/**
 * WHICH WS EVENTS ALSO REACH THE WINDOW THAT OWNS THE SSE.
 *
 * A window that sent the message receives the turn on its own SSE stream, so WS
 * events for that same session are normally dropped for it: they would arrive
 * twice. The list below is the EXCEPTIONS - the events that do not exist on the
 * SSE at all, and for which dropping means never receiving them.
 *
 * It lives outside `useChat` because it is precisely the thing that turned out
 * to be incomplete, twice, and inside a two-thousand-line hook it could not
 * fail in a test:
 *
 *  · `stream:usage` - the tally does not travel on the SSE.
 *  · `stream:tool_permission_required` - the permission panel travels only over
 *    WS. Without it the window you sent from was BLIND to the panel that was
 *    waiting for it, while the phone showed it.
 *  · `stream:tool_permission_resolved` - and without this one the previous cure
 *    was half a cure: the panel appeared and never went away. After clicking
 *    "allow" the four buttons stayed grey with a spinner for the whole duration
 *    of the tool, while the answer scrolled underneath.
 *
 * THE RULE FOR ADDING ONE, which is the part that matters: the event must write
 * a FIXED state on the row, not accumulate. Receiving it twice has to leave the
 * exact same state. An event that adds up (a text delta, a counter) would
 * double here.
 */
export type SenderVisibleEventType =
  | 'stream:usage'
  | 'stream:tool_permission_required'
  | 'stream:tool_permission_resolved';

/** The exceptions, in one place, so a test can count them. */
export const SENDER_ALSO_SEES: readonly SenderVisibleEventType[] = [
  'stream:usage',
  'stream:tool_permission_required',
  'stream:tool_permission_resolved',
];

/** Should this event also be delivered to whoever owns that session's SSE? */
export function senderAlsoSees(eventType: string): boolean {
  return (SENDER_ALSO_SEES as readonly string[]).includes(eventType);
}

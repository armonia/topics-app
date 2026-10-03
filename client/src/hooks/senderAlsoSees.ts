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
 *  · `stream:tool_user_input_required` - the question panel. Same story as the
 *    permission one, found on 23/09 ("I have to refresh to see the real state
 *    of a topic"): the sidebar said "waiting for you", the chat you sent from
 *    showed a spinner, and only a reload painted the form. Writes a status and
 *    a schema.
 *  · `stream:tool_detail` - a sub-agent's live progress. A whole snapshot that
 *    replaces the previous one.
 *  · `stream:compaction` - the compaction divider. An upsert by marker id.
 *  · `stream:tool_update` - the live output of a running command (CHAT-TOOL-09).
 *    It REPLACES `result` with the whole current tail, and the window you sent
 *    from, the one surely watching, saw only a spinner for minutes. A partial
 *    can reach it after the result from the SSE: `withPartialResult` refuses to
 *    write on a row that has closed.
 *
 * THE RULE FOR ADDING ONE, which is the part that matters: the event must write
 * a FIXED state on the row, not accumulate. Receiving it twice has to leave the
 * exact same state. An event that adds up (a text delta, a counter) would
 * double here.
 */
export type SenderVisibleEventType =
  | 'stream:usage'
  | 'stream:tool_permission_required'
  | 'stream:tool_permission_resolved'
  | 'stream:tool_user_input_required'
  | 'stream:tool_detail'
  | 'stream:compaction'
  | 'stream:tool_update';

/** The exceptions, in one place, so a test can count them. */
export const SENDER_ALSO_SEES: readonly SenderVisibleEventType[] = [
  'stream:usage',
  'stream:tool_permission_required',
  'stream:tool_permission_resolved',
  'stream:tool_user_input_required',
  'stream:tool_detail',
  'stream:compaction',
  'stream:tool_update',
];

/** Should this event also be delivered to whoever owns that session's SSE? */
export function senderAlsoSees(eventType: string): boolean {
  return (SENDER_ALSO_SEES as readonly string[]).includes(eventType);
}

/**
 * The same gate on a whole frame. A frame of a turn the server already closed
 * (`late: true`) is never a copy of the local SSE, which belongs to the NEXT
 * turn.
 */
export function senderAlsoSeesFrame(frame: { type: string; late?: unknown }): boolean {
  return frame.late === true || senderAlsoSees(frame.type);
}

/** What this window sent on the own stream it still holds: the keys and the text of each message. */
export interface OwnSends {
  clientIds: ReadonlySet<string>;
  contents: ReadonlySet<string>;
}

/**
 * A `message:new` for a session whose turn THIS window streams over its own SSE:
 * is it that turn coming back, or a row written beside it?
 *
 * The pane handler used to drop EVERY `message:new` of an own stream, to avoid
 * doubling the bubbles the SSE already draws. But the server also writes rows
 * that have nothing to do with the turn, and the race that shows it is the
 * stopped-by-parent card (`server/services/subagent-wake.ts`): the wake writes
 * it at the first poll after `activeStreams` empties, `endStream` empties it
 * BEFORE `[DONE]`, and this window keeps the stream as its own until the
 * `finally` after the history reload. A row written in that window never
 * reached the pane until the next reload.
 *
 * The turn's echo is two rows, and only those two:
 *  · the person's row of the message THIS window sent: the server announces it
 *    with the `clientMessageId` the send carried (`server/routes/chat.ts`), or,
 *    from a server that does not, with the very text that was sent. Any other
 *    `user` row is written by the machine beside the turn: the wake's
 *    sub-agent result, the goal's continuation, the board's envelope, an owed
 *    answer the send carried in front of itself.
 *  · the reply, which the server announces WITHOUT blocks (every branch that
 *    closes a turn) and which the SSE already drew under a local id.
 * Everything else passes, deduplicated by id against what the pane already
 * holds.
 */
export function ownTurnEcho(
  frame: { role?: string; blocks?: readonly unknown[] | null; content?: string; preview?: string; clientMessageId?: string },
  sent: OwnSends,
): boolean {
  if (frame.role === 'assistant') return !frame.blocks || frame.blocks.length === 0;
  if (frame.role !== 'user') return false;
  if (frame.clientMessageId) return sent.clientIds.has(frame.clientMessageId);
  return sent.contents.has(frame.content ?? frame.preview ?? '');
}

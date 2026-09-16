/**
 * THE ROW OF A LIVE TURN, WRITTEN NOW BECAUSE SOMEBODY IS ABOUT TO READ IT.
 *
 * THE DEFECT. `blocks` is the only column that carries tool calls on a modern
 * row (`tool_calls` is emptied when blocks are present: on the live database
 * all 6916 assistant rows with blocks have it empty), and `blocks` goes through
 * a throttle - between 1 and 15 seconds of delay for anything that is not the
 * first write of the turn or a doubling of the payload. That is right for a
 * reader who follows the WebSocket, which is everybody... except a piece of
 * server code that reads the ROW to find out which tool is waiting.
 *
 * `routes/outbound.ts` is exactly that reader: to paint a confirmation it looks
 * for the tool call in the last persisted assistant row. For a `send_mail` that
 * is not the first tool of its turn, that row does not have it yet, and a
 * question with no row and no card was refused outright - "there is no card
 * thread and no visible tool row to ask on". A write that is merely LATE was
 * being read as a person who does not exist.
 *
 * THE FIX IS THE ONE `routes/chat.ts` ALREADY APPLIES for the same reason ("a
 * tool that stops to ask is written NOW"): force the pending write before
 * reading. This registry is how a reader outside the stream closure can reach
 * the writer of the turn it is reading - the throttle lives inside the handler,
 * which is where it has to live, since it owns the timeline.
 *
 * It is a plain map and not a WeakMap or a queue: one entry per streaming
 * session, removed by the handler that owns it when the turn ends. A flush for
 * a session with no live turn does nothing and says so, which is the honest
 * answer for a row that is already final.
 */

const flushers = new Map<string, () => void>();

/**
 * Publish the flush of a live turn. Returns the function that takes it back
 * down: the turn that registered is the only one allowed to unregister, so a
 * turn ending after a newer one started cannot remove somebody else's entry.
 */
export function registerTurnBodyFlush(sessionKey: string, flush: () => void): () => void {
  flushers.set(sessionKey, flush);
  return () => {
    if (flushers.get(sessionKey) === flush) flushers.delete(sessionKey);
  };
}

/**
 * Write the body of this session's live turn now, if one is pending. Returns
 * true when a live turn answered, false when there is none: the caller reads
 * the row either way, and the difference only matters to a test.
 */
export function flushTurnBody(sessionKey: string): boolean {
  const flush = flushers.get(sessionKey);
  if (!flush) return false;
  try {
    flush();
    return true;
  } catch {
    // A row that could not be written is not a reason to refuse a send: the
    // caller falls back to reading whatever is on disk.
    return false;
  }
}

/** Only for the tests: the registry is process memory. */
export function _resetTurnBodyFlushers(): void {
  flushers.clear();
}

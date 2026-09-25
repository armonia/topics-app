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
 * It is a plain map and not a WeakMap or a queue, each entry removed by the
 * handler that owns it when its turn ends. A flush for a session with no live
 * turn does nothing and says so, which is the honest answer for a row that is
 * already final.
 *
 * A SET per session, not one slot: a closed turn's late answer registers its
 * flush while the next turn of the same chat is live (lib/late-answer-lane.ts),
 * and one slot let either hide the other's pending write from the reader.
 */

/** The writer of a live turn, as the readers and the failure paths reach it. */
interface TurnWriter {
  flush: () => void;
  /** The row it writes, and how it stops: only the turn's own writer has them. */
  rowId?: () => string;
  stop?: () => void;
}

const flushers = new Map<string, Set<TurnWriter>>();

/**
 * Publish the flush of a live turn. Returns the function that takes it back
 * down: the turn that registered is the only one allowed to unregister, so a
 * turn ending after a newer one started cannot remove somebody else's entry.
 */
export function registerTurnBodyFlush(
  sessionKey: string,
  flush: () => void,
  owner?: { rowId: () => string; stop: () => void },
): () => void {
  const own = flushers.get(sessionKey) ?? new Set<TurnWriter>();
  const writer: TurnWriter = { flush, ...owner };
  own.add(writer);
  flushers.set(sessionKey, own);
  return () => {
    own.delete(writer);
    if (own.size === 0 && flushers.get(sessionKey) === own) flushers.delete(sessionKey);
  };
}

/**
 * A turn closes on a FAILURE: the writer of its row writes the work it still
 * owes and stops, and no reader reaches it any more.
 *
 * The failure paths of `routes/chat.ts` used to close the row and leave the
 * writer registered. Once a flush wrote the whole body, the next reader of the
 * chat (a history read, a catch-up, the outbound gate) wrote that body over
 * the failure notice. Called BEFORE `endStream`, which closes the tools still
 * running on the row: after it, the write would open them again.
 */
export function stopTurnBodyOf(rowId: string | null | undefined): void {
  if (!rowId) return;
  for (const [sessionKey, own] of flushers) {
    for (const writer of [...own]) {
      if (writer.rowId?.() !== rowId) continue;
      try {
        writer.stop?.();
      } catch {
        // The failure is still written by the caller: a body that could not be
        // written is not a reason to leave the writer running.
      }
      own.delete(writer);
    }
    if (own.size === 0 && flushers.get(sessionKey) === own) flushers.delete(sessionKey);
  }
}

/**
 * Write the body of this session's live turn now, if one is pending. Returns
 * true when a live turn answered, false when there is none: the caller reads
 * the row either way, and the difference only matters to a test.
 */
export function flushTurnBody(sessionKey: string): boolean {
  const own = flushers.get(sessionKey);
  if (!own || own.size === 0) return false;
  let flushed = true;
  for (const writer of [...own]) {
    try {
      writer.flush();
    } catch {
      // A row that could not be written is not a reason to refuse a send: the
      // caller falls back to reading whatever is on disk.
      flushed = false;
    }
  }
  return flushed;
}

/** Only for the tests: the registry is process memory. */
export function _resetTurnBodyFlushers(): void {
  flushers.clear();
}

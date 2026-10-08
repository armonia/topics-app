/**
 * WHERE A BROKER SESSION STANDS IN ITS STORE, and the rule that keeps that
 * place honest when its child exits (T19).
 *
 * The ai-bridge daemon keeps each child's output in an append-only store and
 * sends it to us in `data` frames addressed by offset. The provider folds them
 * synchronously and moves `consumedOffset` past them. When the child exits
 * while we are detached, its `exit` is a broadcast and reaches us anyway, but
 * the bytes it wrote after the cut were never sent to us (`closeAfterTail`).
 *
 * Kept out of `claude-code.ts` because it is a rule about offsets, not about
 * the turn, and that file sits at its size ceiling (`check-bloat`).
 */

/** The fields of a broker `PersistentProcess` these rules read and move. */
export interface BrokerCursor {
  sessionKey: string;
  consumedOffset: number;
  alive: boolean;
  aborting?: boolean;
  stoppedExit?: unknown;
  attachPending?: boolean;
}

/**
 * The child exited: close its turn, after folding what it wrote past our
 * cursor if we were detached (T19).
 *
 * The daemon's `exit` carries its `endOffset`. Attached, every `data` frame
 * precedes the exit on the socket and the gap is zero: nothing changes for a
 * healthy turn. Detached (an attach lost, a socket that dropped), the final text
 * and the `result` sit in the store only, and the turn used to close without
 * them, leaving the row short even after a reload. The daemon keeps the store
 * of a child that exited by itself for a late attach, so one attach from the
 * cursor folds them before the close.
 *
 * Closed as before, saying why the tail was not there: a daemon older than the
 * field (no `endOffset`, no gap to see), a killed child (its store is unlinked
 * with the exit: the attach answers `missing`), a turn stopped by the person
 * (its tail is dropped anyway), a cursor that is not ours to fetch from.
 *
 * `alive` drops before the fetch: a send queued behind this turn starts the
 * moment its `result` folds, and must spawn a fresh child, not write to this
 * dead one. One attempt, like the lag probe: a retry recycles the socket every
 * session shares.
 */
export function closeAfterTail(
  c: BrokerCursor,
  endOffset: number | undefined,
  fetch: (from: number) => Promise<{ missing?: boolean }>,
  close: (wasAlive: boolean) => void,
): void {
  const gap = typeof endOffset === "number" ? endOffset - c.consumedOffset : 0;
  if (gap <= 0) { close(c.alive); return; }
  const skip = !c.alive ? "its process was already given up"
    : c.aborting || c.stoppedExit ? "the turn was stopped, and a stopped child's tail is dropped"
    : c.attachPending ? "its first attach had not landed, so there is no cursor of ours to fetch from"
    : null;
  if (skip) {
    console.warn(`[claude-code] ${c.sessionKey} exited ${gap} byte(s) past what we folded, not fetched: ${skip}`);
    close(c.alive);
    return;
  }
  const wasAlive = c.alive;
  c.alive = false;
  console.warn(`[claude-code] ${c.sessionKey} exited while detached: ${gap} byte(s) past offset ${c.consumedOffset} never reached us, fetching them before closing`);
  fetch(c.consumedOffset)
    .then(
      (res) => { if (res.missing) console.warn(`[claude-code] ${c.sessionKey}: its tail is lost, the daemon dropped its store (the child was killed)`); },
      (err) => console.warn(`[claude-code] ${c.sessionKey}: could not fetch its tail (${err instanceof Error ? err.message : String(err)}), closing without it`),
    )
    .then(() => close(wasAlive))
    .catch((err) => console.error(`[claude-code] closing ${c.sessionKey} after its tail threw:`, err));
}

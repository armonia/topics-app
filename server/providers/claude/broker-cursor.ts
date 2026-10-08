/**
 * WHERE A BROKER SESSION STANDS IN ITS STORE, and the two rules that keep that
 * place honest (T18, T19).
 *
 * The ai-bridge daemon keeps each child's output in an append-only store and
 * sends it to us in `data` frames addressed by offset. The provider folds them
 * synchronously and moves `consumedOffset` past them. Two things happen around
 * that cursor that the provider used to get wrong:
 *
 *  - a re-attach replays from the cursor it was SENT with, so frames already in
 *    flight arrive twice (`admitFrame`);
 *  - the child exits while we are detached: its `exit` is a broadcast and
 *    reaches us anyway, but the bytes it wrote after the cut were never sent to
 *    us (`closeAfterTail`).
 *
 * Kept out of `claude-code.ts` because they are rules about offsets, not about
 * the turn, and that file sits at its size ceiling (`check-bloat`).
 */

/** The fields of a broker `PersistentProcess` these rules read and move. */
export interface BrokerCursor {
  sessionKey: string;
  consumedOffset: number;
  alive: boolean;
  /** The reattach's muted scan: it folds nothing visible, so a repeat costs nothing. */
  replayMute?: boolean;
  /** The one rewind we asked for, below the cursor: see `admitFrame`. */
  rewindFrom?: number;
  aborting?: boolean;
  stoppedExit?: unknown;
  attachPending?: boolean;
  /** The cursor was left by a failed re-adoption: the next re-attach is live (`resyncNow`). */
  reattachLive?: boolean;
  /** The tail being fetched by `closeAfterTail`, until the turn is closed. */
  exitTail?: Promise<void>;
}

/**
 * A BYTE IS FOLDED ONCE. Which part of a `data` frame may be folded, or null
 * for none of it.
 *
 * A re-attach replays from the cursor it was SENT with, and frames the daemon
 * had already written to the socket before it read that `attach` arrive first:
 * the replay then repeats them, and folding them again doubled the deltas on
 * screen (137 numbers out of 1500 with overlapping re-attaches, T18). Below the
 * cursor only the muted scan may fold.
 *
 * And the one rewind we ask for on purpose: the reattach's second attach (and
 * its replay of a turn that completed while we were away) starts at the open
 * turn, below a cursor the scan has carried to the end. It used to be let
 * through by its `replaySilent` flag, and so was every frame of the scan's
 * still-live attach that landed while it was on its way: folded live, then
 * again by the replay (43 numbers out of 600, T19). Now it is named by its
 * offset: until a frame starts exactly there, every frame is one the replay
 * will repeat, and is dropped; from there on the replay is contiguous.
 */
export function admitFrame(c: BrokerCursor, chunk: Buffer, offset: number): { chunk: Buffer; offset: number } | null {
  if (c.rewindFrom !== undefined) {
    if (offset !== c.rewindFrom) return null;
    c.rewindFrom = undefined;
    return { chunk, offset };
  }
  if (offset < c.consumedOffset && !c.replayMute) {
    const seen = c.consumedOffset - offset;
    if (seen >= chunk.byteLength) return null;
    return { chunk: chunk.subarray(seen), offset: c.consumedOffset };
  }
  return { chunk, offset };
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
 * dead one. It waits for `exitTail` first (`processForTurn`): frames name only
 * the session, so a tail still on its way when the next child is spawned would
 * be folded by that child's handlers. Set only while a tail is on its way: a
 * send that awaited it on every turn gave a Stop one tick less to find it
 * waiting. One attempt, like the lag probe: a retry recycles the socket every
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
    : c.reattachLive ? "its cursor was left by a failed re-adoption, and the history behind it is no new turn"
    : null;
  if (skip) {
    console.warn(`[claude-code] ${c.sessionKey} exited ${gap} byte(s) past what we folded, not fetched: ${skip}`);
    close(c.alive);
    return;
  }
  const wasAlive = c.alive;
  c.alive = false;
  console.warn(`[claude-code] ${c.sessionKey} exited while detached: ${gap} byte(s) past offset ${c.consumedOffset} never reached us, fetching them before closing`);
  c.exitTail = fetch(c.consumedOffset)
    .then(
      (res) => { if (res.missing) console.warn(`[claude-code] ${c.sessionKey}: its tail is lost, the daemon dropped its store (the child was killed)`); },
      (err) => console.warn(`[claude-code] ${c.sessionKey}: could not fetch its tail (${err instanceof Error ? err.message : String(err)}), closing without it`),
    )
    .then(() => { c.exitTail = undefined; close(wasAlive); })
    .catch((err) => console.error(`[claude-code] closing ${c.sessionKey} after its tail threw:`, err));
}

/**
 * A FAILED RE-ADOPTION'S MARK ENDS WHERE THE NEXT TURN BEGINS.
 *
 * `finalizeFailedReattach` leaves `reattachLive`: the cursor is where the scan
 * stopped, and the next resync starts at the store's end, past the history the
 * scan left unfolded (`resyncNow`). Nothing else spent the mark: with the cursor
 * already at the end the lag probe sees no gap and never resyncs. It outlived
 * whole turns, and the first resync of a later, healthy turn jumped to the end
 * past that turn's own tail, `result` included. The answer came out cut and the
 * turn hung until the watchdog (verification of T19, 08/10: "a1,a2," instead of
 * "a1,a2,a3,"; the turn adopted after the restart had been refused for a rate
 * limit, with its child alive).
 *
 * When a turn starts, everything already in the store is history: the cursor
 * moves to the end before the message goes, and the mark is spent. If the
 * daemon cannot be reached, the mark stays for the next resync, as before.
 */
export async function spendLiveMark(c: BrokerCursor, attachLive: () => Promise<{ fromOffset: number }>): Promise<void> {
  if (!c.reattachLive) return;
  try {
    const { fromOffset } = await attachLive();
    c.consumedOffset = Math.max(c.consumedOffset, fromOffset);
    c.reattachLive = false;
  } catch (err) {
    console.warn(`[claude-code] ${c.sessionKey}: could not move past a failed re-adoption's history before the turn (${err instanceof Error ? err.message : String(err)}); the next resync stays live`);
  }
}

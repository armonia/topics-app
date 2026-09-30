/**
 * THE TURN OF A SESSION HAS ENDED: the one signal the server owns for it.
 *
 * A turn's entry leaves `activeStreams` in `endStream` (utils.ts) and, for an
 * entry whose row was already final, in the two sweeps that drop it silently
 * (the stale-stream sweep's fast path, the catch-up frame builder). Each of
 * those says so here, right after the delete, so whoever waits for the session
 * to be free (an answer owed to the model, `lib/answer-relay.ts`) acts at
 * that moment instead of polling for it.
 *
 * Listeners run synchronously and must not throw into the caller: `endStream`
 * is on every turn's way out.
 */
type Listener = (sessionKey: string) => void;

const listeners = new Set<Listener>();

/** Subscribe to every turn end; the returned function unsubscribes. */
export function onTurnEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Say that the turn in flight on this session is over. */
export function announceTurnEnded(sessionKey: string): void {
  for (const listener of listeners) {
    try { listener(sessionKey); } catch (err) {
      console.warn(`[turn-ended] a listener failed for ${sessionKey}:`, err);
    }
  }
}

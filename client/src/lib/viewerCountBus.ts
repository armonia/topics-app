/**
 * Where a pushed viewer count lands, and who is listening for it.
 *
 * The server pushes `{type:'viewers', count}` on `/ws/browser/:contextId`
 * whenever the count of a context changes (see shared/browser-ws-messages.ts).
 * Two different sockets can carry it for the same pane: the native executor
 * socket while the pane is native, the streaming socket while it is shared.
 * Neither owns the auto-share decision, which lives in `useSharedViewerCount`.
 * This bus is the meeting point: the sockets push here, the hook subscribes
 * here, and nobody has to know which socket is up.
 *
 * It also answers the one question the fallback poll needs: is ANY socket of
 * this context up right now? While one is, a change reaches the pane by push
 * and the poll can sleep; while none is, the poll is the only source.
 *
 * Module-level on purpose (one map per window): the sockets and the hook are
 * mounted by different components and share no React tree.
 */

type Listener = (count: number) => void;

const listeners = new Map<string, Set<Listener>>();
/** How many live sockets carry pushes for the context. */
const channels = new Map<string, number>();
/** The last pushed value, for a subscriber that arrives after the socket did. */
const lastCount = new Map<string, number>();

/** A socket received a count for `contextId`: fan it out. */
export function pushViewerCount(contextId: string, count: number): void {
  lastCount.set(contextId, count);
  const set = listeners.get(contextId);
  if (!set) return;
  for (const fn of [...set]) fn(count);
}

/**
 * Hear every pushed count for `contextId`. If a value was pushed before this
 * subscription (the socket opened first), it is delivered right away: the
 * server sends the current count to a socket the moment it opens, and losing
 * that one would leave the pane on its first reading until the next change.
 */
export function subscribeViewerCount(contextId: string, fn: Listener): () => void {
  let set = listeners.get(contextId);
  if (!set) {
    set = new Set();
    listeners.set(contextId, set);
  }
  set.add(fn);
  const last = lastCount.get(contextId);
  if (last !== undefined && hasViewerChannel(contextId)) fn(last);
  return () => {
    const s = listeners.get(contextId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(contextId);
  };
}

/**
 * A socket for `contextId` is open and forwards `viewers` frames. Returns the
 * detach to call when it closes. The stored last value dies with the last
 * channel: a count from a socket that is gone is not a fact about now.
 */
export function attachViewerChannel(contextId: string): () => void {
  channels.set(contextId, (channels.get(contextId) ?? 0) + 1);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    const n = (channels.get(contextId) ?? 1) - 1;
    if (n <= 0) {
      channels.delete(contextId);
      lastCount.delete(contextId);
    } else {
      channels.set(contextId, n);
    }
  };
}

/** Is at least one socket of `contextId` up, so a change would be pushed? */
export function hasViewerChannel(contextId: string): boolean {
  return (channels.get(contextId) ?? 0) > 0;
}

/** Test-only: forget everything. */
export function resetViewerCountBusForTests(): void {
  listeners.clear();
  channels.clear();
  lastCount.clear();
}

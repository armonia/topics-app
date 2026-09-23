/**
 * Expiry for a split that is waiting on a companion chat.
 *
 * `useProjectLayout.handleSplitGroup` parks the gesture when the group holds a
 * single pane: moving that pane out would empty the group, so it asks for a
 * real chat first and replays the split once the chat has joined. The chat is
 * created on the server, so it lands a few frames later.
 *
 * Without a deadline the parked intent just waited. Ask for the split, let the
 * chat fail to arrive, forget about it, and then an hour later add a tab to
 * that group by hand: the group fills up, the effect fires, and the pane jumps
 * into a split nobody asked for any more.
 */

/**
 * How long a parked split stays valid. A companion chat is one server
 * round-trip, so seconds is the honest scale; 10 leaves room for a slow or
 * retried creation while being far short of "the user has moved on". Past it
 * the intent is dropped, not replayed: a split that never happened is a much
 * smaller surprise than one that happens by itself later.
 */
export const COMPANION_SPLIT_TTL_MS = 10_000;

/** True when a split parked at `askedAt` is still the gesture the user made. */
export function companionSplitIsFresh(askedAt: number, now: number): boolean {
  return now - askedAt < COMPANION_SPLIT_TTL_MS;
}

/**
 * WHICH SESSIONS HOLD, IN THE MESSAGE STORE, THE DEVICE'S LOCAL COPY AND
 * NOTHING THE SERVER HAS CONFIRMED YET.
 *
 * At boot `useChat` fills the store from `messages-cache-*`: the tail the
 * server's first page holds (`shared/history-paging.ts`). For those sessions a
 * chat that opens can show its rows without waiting for that page
 * (MessageList's curtain), and the page that lands later must not grow the list
 * from the top (`rowsAboveLocalCopy` in `useChat.loadHistory`).
 *
 * "The store has rows" is NOT the same fact: a `message:new` for a chat this
 * window never read puts ONE row in the store, and treating that row as the
 * copy would show a one-row chat, then cut the page above it. So the set is
 * written where the copy enters the store and cleared where the server's answer
 * replaces it, and nowhere else.
 *
 * A module, not React state: it is read inside a frame loop and inside
 * `loadHistory`, and nothing renders from it.
 */

const fromLocalCopy = new Set<string>();

/** The store was just filled from the local copy for these sessions. */
export function noteLocalCopyRows(sessionKeys: Iterable<string>): void {
  for (const key of sessionKeys) fromLocalCopy.add(key);
}

/** Does this session still show the local copy, unconfirmed by the server? */
export function showsLocalCopyRows(sessionKey: string): boolean {
  return fromLocalCopy.has(sessionKey);
}

/** The server answered for this session: its rows are no longer the copy. */
export function settleLocalCopyRows(sessionKey: string): void {
  fromLocalCopy.delete(sessionKey);
}

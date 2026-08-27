/**
 * One `MediaQueryList` per query, for the whole session.
 *
 * WHY. `window.matchMedia(q)` is not a read, it is an ALLOCATION: every call
 * builds a new `MediaQueryList` and attaches it to the document's media query
 * matcher, which holds on to it. `lib/reducedMotion.ts` measured what that
 * costs in this app: live `MediaQueryList` objects went from 379 to 1120 in
 * 104 minutes on a screen nobody was touching, about seven per minute, none of
 * them ever read again.
 *
 * That module fixed ONE query by memoizing it. The same call shape was left in
 * five other places, and two of them are hot: `useMobile` rebuilds its state on
 * every `resize` and `orientationchange` for EVERY consumer (it is read per
 * sidebar row), and `useMediaQuery` allocates twice per mount. A memo per
 * module would be five memos; the query string is the natural key, so the memo
 * belongs here, once.
 *
 * The list is safe to share: `matches` stays live on its own (the browser
 * updates it), and a `change` listener is added and removed by each consumer
 * with its own handler identity, so sharing the object does not merge the
 * subscriptions.
 */

/** Memoized lists, keyed by query text. `null` = this environment has no
 *  `matchMedia` (SSR, unit tests), a state worth remembering so it is not
 *  retried on every call. */
const lists = new Map<string, MediaQueryList | null>();

/**
 * The one `MediaQueryList` for `query`, or `null` outside a browser.
 * Safe in a hot path: after the first call it is a Map lookup.
 */
export function mediaQuery(query: string): MediaQueryList | null {
  const hit = lists.get(query);
  if (hit !== undefined) return hit;
  const built = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
  lists.set(query, built);
  return built;
}

/** `true` if the query matches right now. Outside a browser: `false`. */
export function mediaQueryMatches(query: string): boolean {
  return mediaQuery(query)?.matches ?? false;
}

/** Tests only: forget the memoized lists (a fake `matchMedia` installed by a
 *  test would otherwise be shadowed by the list built from the previous one). */
export function resetMediaQueryCache(): void {
  lists.clear();
}

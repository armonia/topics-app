/**
 * Which chip a card shows, when the dispatch state alone is not the whole truth.
 *
 * `delivered` means "the agent handed the work over: approve or reject". A card
 * the reaper pushed into review after burning every attempt carries the SAME
 * state, so on the board the two look identical, and you only find out which
 * one you are holding after opening the card and reading the thread. Measured
 * on `a035f945`: four turns, no summary, the agent never moved it itself, and a
 * green "consegnato" chip on the front.
 *
 * The field that knows is `deliveredBy`: the store writes `'system'` exactly
 * when nobody handed anything over. So a system delivery gets its own chip,
 * amber and not green, and the review column stops mixing "look at this work"
 * with "this run died".
 *
 * Pure and separate from the component for the usual reason: a rule inside a
 * render body is a rule that can only be checked by rendering.
 */
export function chipKey(state: string, deliveredBy?: string | null, hasWork = true): string {
  if (state !== 'delivered') return state;
  // Nothing produced beats who moved it. A card with no branch, no commit and
  // no changed file has nothing to open, and that is true whether the agent
  // handed it over or the reaper pushed it: measured on the live board, 17 of
  // 24 cards in review had none of the three, and 15 of them wore the green
  // "consegnato". Green there is a promise the card cannot keep.
  if (!hasWork) return 'delivered_empty';
  return deliveredBy === 'system' ? 'delivered_by_system' : 'delivered';
}

/** The three columns that say a run left something behind. */
export function taskHasWork(t: { deliveryBranch?: string | null; deliveryCommit?: string | null; deliveryFilesChanged?: number | null }): boolean {
  return Boolean(t.deliveryBranch || t.deliveryCommit || (t.deliveryFilesChanged ?? 0) > 0);
}

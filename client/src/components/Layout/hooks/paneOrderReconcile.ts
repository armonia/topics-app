/**
 * Reconcile a persisted tab-ORDER list against the set of currently-open pane
 * ids, enforcing the layout's core invariant: the tab strip is a pure function
 * of the open set, and **a pane id is a single identity — it appears at most
 * once**.
 *
 * Why this exists: `orderedIds` is a SECOND source of truth (persisted in
 * localStorage via `savePanelOrder`) laid over the store's open set
 * (`topicIds`). The old memo filtered `orderedIds` down to ids present in the
 * open set but never de-duplicated it — so a persisted order that carried the
 * same id twice (a buggy save, a cross-tab merge, an external write) rendered
 * the SAME pane as two or three identical tabs, even though the store held the
 * id exactly once. That is the "3 tab identiche su un solo pane" bug: the strip
 * diverged from its own store because the reconcile wasn't idempotent on
 * identity.
 *
 * Rules, in order:
 *   1. keep only ids that are still open (`openIds` membership),
 *   2. keep only the FIRST occurrence of each id (dedupe by identity),
 *   3. preserve the surviving order.
 *
 * Returns the SAME array reference when nothing changed (no drop, no dupe) so
 * the caller's `useMemo`/`setState` short-circuit avoids a needless re-render —
 * matching the previous `filtered.length === orderedIds.length ? orderedIds`
 * fast-path, now also covering the dedupe case.
 */
export function reconcilePaneOrder(orderedIds: string[], openIds: Iterable<string>): string[] {
  const openSet = openIds instanceof Set ? openIds : new Set(openIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of orderedIds) {
    if (!openSet.has(id)) continue; // not open → no tab (pure function of the store)
    if (seen.has(id)) continue; // already placed → one identity, one tab
    seen.add(id);
    out.push(id);
  }
  // Unchanged (same length ⇒ no id dropped AND no dupe collapsed, because a
  // dropped/collapsed id can only SHRINK the list) → return the original ref.
  return out.length === orderedIds.length ? orderedIds : out;
}

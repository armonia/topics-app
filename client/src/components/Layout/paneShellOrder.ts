/**
 * THE DOM ORDER OF THE PANE SHELLS IS NOT THE TAB ORDER, AND MUST NOT BE.
 *
 * Every visited pane keeps its shell mounted (`PaneKeepAlive`); only the active
 * one is `display: flex`, the others are `display: none`. Rendering that list in
 * TAB order looked harmless - nobody can see the order of invisible boxes - but
 * it tied the DOM to the strip: reorder a tab and React answers with
 * `insertBefore`, which is a detach plus a re-attach of a live subtree.
 *
 * What that costs, measured on the reposition of one tab
 * (`tests/e2e/tab-reposition-no-reload.spec.ts`, before this function existed):
 * one pane shell detached, one iframe rebuilt, one iframe `load` - that is the
 * browser pane throwing away its document and loading it again, which is the
 * loader the user sees for a moment. A detached scroller also comes back at
 * scrollTop 0.
 *
 * The cure is to give the shells an order that no gesture can change. Sorting on
 * the pane key is enough and needs no memory of previous renders: the key of a
 * pane does not change while it is mounted (`stableKey` survives PANE_ID_REMAP),
 * so the relative order of the mounted shells is frozen, and React has nothing
 * to move. A NEW pane is inserted wherever its key falls: inserting a node does
 * not detach its siblings, so mounting one pane never reloads another.
 *
 * The order itself is arbitrary and deliberately so - it is invisible. Anything
 * that must respect the tab order (the strip, the keyboard cycle, the
 * activation) reads the pane list, not this one.
 */
export function paneShellOrder<T>(panes: readonly T[], keyOf: (pane: T) => string): T[] {
  return [...panes].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

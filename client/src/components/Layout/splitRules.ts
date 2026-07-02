/**
 * splitRules — the ONE source of truth for "can this tab be split out of its
 * group?", shared by BOTH tiling surfaces so the context-menu entries, the
 * drag-to-edge path and the runtime handlers can never drift again (they used
 * to disagree three ways: standalone menu vs standalone drag vs project).
 *
 * The rules, per surface:
 *
 *  - `standalone-pool` (the main standalone group): ALWAYS splittable. A
 *    single-tab pool auto-spawns a draft companion (PanelGrid.handleSplitPane)
 *    so the split always yields two visible cells. Utility panes and draft
 *    tabs are splittable too: utility panes render fine as solo cells, and
 *    draft cells survive promotion via the `topics:pane-id-remap` event
 *    (PanelGrid remaps soloCells + grid keys when the draft becomes a topic)
 *    — the old "state model doesn't survive the move" block predates that.
 *
 *  - `standalone-solo` (a `solo:<primary>` split cell): splittable iff the
 *    cell holds MORE than one tab — splitting a member out of a multi-tab
 *    cell is meaningful (it moves into its own new cell, like the drag path's
 *    extractToOwnCell), while the lone tab of a single-tab cell has nothing
 *    left to split away from.
 *
 *  - `project` (a GroupLayout group): splittable iff the group has another
 *    pane to leave behind. Splitting the only pane of a group into itself is
 *    a visual no-op (the new group would just replace the old in place), so
 *    the entries hide instead of silently failing.
 *
 * Callers use the SAME predicate to (a) hide/disable the menu entries, and
 * (b) guard the handlers — so an offered gesture always works and a refused
 * one is never promised.
 */

export type SplitSurface = 'standalone-pool' | 'standalone-solo' | 'project';

export interface SplitContext {
  /** Which tiling surface / group kind hosts the pane. */
  surface: SplitSurface;
  /** Number of panes currently in the pane's group (pool / cell / group). */
  groupSize: number;
}

/** True when a tab in a group described by `ctx` may be split out. */
export function canSplitPane(ctx: SplitContext): boolean {
  if (ctx.surface === 'standalone-pool') return true;
  return ctx.groupSize > 1;
}

/** Map a standalone grid item key ('standalone' | 'solo:<id>') to its surface. */
export function standaloneSplitSurface(gridItemKey: string): SplitSurface {
  return gridItemKey.startsWith('solo:') ? 'standalone-solo' : 'standalone-pool';
}

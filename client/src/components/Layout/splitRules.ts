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
 *  - `project` (a GroupLayout group): ALWAYS splittable (mirrors
 *    standalone-pool). When a single-pane group is split, `handleSplitGroup`
 *    in useProjectLayout asks for a REAL chat of the project (a draft has no
 *    topic to draw and nothing persists it, so its cell died on reload and
 *    took the split with it) and replays the split once that chat has joined
 *    the group; the original pane then moves to the new split group.
 *
 * Callers use the SAME predicate to (a) show/hide the menu entries, and
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
  if (ctx.surface === 'standalone-solo') return ctx.groupSize > 1;
  // standalone-pool and project: always splittable. For project, a single-pane
  // group split asks for a companion CHAT and replays itself when it lands
  // (useProjectLayout); standalone-pool spawns a draft instead, which is a
  // creature only that surface can draw. The menu entries are always shown.
  return true;
}

/** Map a standalone grid item key ('standalone' | 'solo:<id>') to its surface. */
export function standaloneSplitSurface(gridItemKey: string): SplitSurface {
  return gridItemKey.startsWith('solo:') ? 'standalone-solo' : 'standalone-pool';
}

/** A tab hovering the EDGE band of a standalone grid cell, as the `dragover`
 *  can describe it (no `dataTransfer` values there, only the drag shelf). */
export interface StandaloneEdgeDropContext {
  /** Grid key of the cell under the pointer: `'standalone'` or `solo:<id>`. */
  targetCellKey: string;
  /** The pane in flight, from `lib/dragPayload`. Null when the drag started in
   *  ANOTHER window, where the shelf is empty and only the drop can tell. */
  draggedPaneId: string | null;
  /** Tabs currently in the target cell. */
  targetCellSize: number;
}

/**
 * True when releasing here would actually reshape the grid, so the `dragover`
 * can refuse to paint a gesture the drop is going to throw away.
 *
 * The one refused case is the lone tab of a solo cell released on its OWN
 * cell's edge: there is nothing left to split away from, which is the same
 * answer `canSplitPane` already gives the context menu. The preview used to
 * light up anyway and the release did nothing.
 *
 * A drag from another window is allowed through: the shelf is empty there, so
 * the honest answer is "can't tell", and refusing on a guess would kill a
 * gesture that works.
 */
export function standaloneEdgeDropSplits(ctx: StandaloneEdgeDropContext): boolean {
  const { targetCellKey, draggedPaneId, targetCellSize } = ctx;
  if (!draggedPaneId) return true;
  // Cells are keyed by a chat's TOPIC id while the shelf records the PANE id
  // (`chat:<topicId>`), so the two only compare after this unwrap.
  const draggedId = draggedPaneId.startsWith('chat:') ? draggedPaneId.slice('chat:'.length) : draggedPaneId;
  if (targetCellKey !== `solo:${draggedId}`) return true;
  return canSplitPane({ surface: standaloneSplitSurface(targetCellKey), groupSize: targetCellSize });
}

/** A tab released on the edge band of a group, described by where it came from. */
export interface SplitDropContext {
  /** Which tiling surface hosts the group the tab is being dropped ON. */
  surface: SplitSurface;
  /** Panes in the group the tab is being dragged OUT of. */
  sourceGroupSize: number;
  /** The drop lands on the very group the tab already lives in. */
  sameGroup: boolean;
  /**
   * The drop is on a full-width strip: the pane moves into a NEW row spanning
   * every column, instead of splitting one group in two.
   */
  fullRow?: boolean;
  /**
   * How many groups the surface currently holds. Only read for `fullRow`, and
   * only to tell apart the one arrangement that cannot change: the only pane of
   * the only group, moved into a row of its own.
   */
  totalGroups?: number;
}

/**
 * True when a drag-to-edge release must actually split.
 *
 * Same question as `canSplitPane`, asked from the DRAG path instead of the
 * context menu, and answered by the same rule — that identity is the point.
 * The two paths had drifted: the project surface offered "Split" in the menu
 * (which asks for a companion chat, see `useProjectLayout.handleSplitGroup`)
 * while `GroupLayout`'s drop handler refused the same gesture whenever the
 * source group held a single pane. A project window that opens with one pane in
 * one group is the common case, so drag-to-split was dead exactly where it was
 * first tried: the edge preview painted, the release did nothing.
 *
 * Because a drop on ANOTHER group always yields two visible cells whatever the
 * source held, the source's size only matters for a self-drop.
 *
 * A `dragover` cannot read the payload's VALUES, so the caller resolves the
 * source group through the module shelf (`dragPayload.draggedPaneId`) to ask
 * this the same question the drop will ask. Preview and outcome must agree:
 * a promised gesture that no-ops is worse than one never offered.
 */
export function canDropSplit(ctx: SplitDropContext): boolean {
  // A full-row drop always takes the pane OUT of its group, so it reshapes the
  // tree in every arrangement but one: the only pane of the only group, which
  // lands in a new spanning row while its emptied group is dropped — the same
  // tree, redrawn. Refuse that one rather than promise a no-op.
  if (ctx.fullRow) return ctx.sourceGroupSize > 1 || (ctx.totalGroups ?? 2) > 1;
  if (!ctx.sameGroup) return true;
  return canSplitPane({ surface: ctx.surface, groupSize: ctx.sourceGroupSize });
}

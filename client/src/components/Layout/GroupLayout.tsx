import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import type { Pane, PaneGroup, PaneGroupType, PaneType, GroupLayoutRow } from '../../types';
import { PaneTabBar } from './PaneTabBar';
import { CellSubStack } from './CellSubStack';
import { setColumnStackHeights } from './groupLayoutStacks';
import { useGridResize } from '../../hooks/useGridResize';
import { DND_TYPES, dragMatchesScope } from '../../lib/dndTypes';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useRefMirror } from '../../hooks/useRefMirror';
import { detectDropZone, type EdgeZone } from '../../lib/dropZone';

interface GroupLayoutProps {
  panes: Pane[];
  groups: PaneGroup[];
  rows: GroupLayoutRow[];
  rowHeights: number[];
  focusedGroupId: string | null;
  /** Drag scope for this project's tab bars (its projectPath). Tabs can only
   *  be dragged between groups of the SAME project; a foreign tab (main window
   *  or another project) shows no drop indicators and is ignored on drop. */
  dndScope?: string;
  /** True when the panel hosting this layout is the App-level focused panel.
   *  Drives the dimmed-active vs full-active visual state in PaneTabBar
   *  and the pane content ring, so the active tab stays visually identifiable
   *  even when the project sits next to a focused sibling in split view.
   *  Defaults to true for callers that don't track App-level focus. */
  isAppFocused?: boolean;
  onActivatePane: (groupId: string, paneId: string) => void;
  onClosePane: (groupId: string, paneId: string) => void;
  /** Optional immediate close (bypass PendingAction countdown). Wired via the
   *  PaneTabBar right-click "Close now" entry. */
  onClosePaneImmediate?: (groupId: string, paneId: string) => void;
  onAddPaneToGroup: (groupId: string, type: PaneType, subType?: string) => void;
  onNewChatInGroup?: (groupId: string) => void;
  onAddPaneWhenEmpty?: (type: PaneType, subType?: string) => void;
  onReorderGroupPanes?: (groupId: string, newPaneIds: string[]) => void;
  onMovePaneBetweenGroups?: (sourceGroupId: string, targetGroupId: string, paneId: string, insertIdx: number) => void;
  /**
   * Split a group on an edge. Vertical (top/bottom) splits default to a
   * SINGLE-COLUMN vertical stack — the soloed pane lands under just the
   * target's column. Pass `opts.fullRow` (the container's full-width drop
   * strips) to instead insert a new row spanning every column.
   */
  onSplitGroup?: (sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom', opts?: { fullRow?: boolean }) => void;
  onReorderRows?: (newRowOrder: number[]) => void;
  onUpdateRows: (rows: GroupLayoutRow[]) => void;
  onUpdateRowHeights: (heights: number[]) => void;
  /** Render a pane's body. `isFocused` reflects "this is the active pane
   *  AND its group is the focused group AND the App-level panel is the
   *  focused panel". `isVisible` reflects only "this is the active pane in
   *  its group" — i.e. the keep-alive wrapper is `display:flex`, not
   *  `display:none`. The two diverge in split view: a non-focused group's
   *  active pane is still visible, just dimmed. Browser panes need
   *  isVisible separately because their OS-level WebContentsView can't
   *  observe the wrapper's display property. */
  renderPane: (pane: Pane, isFocused: boolean, isVisible: boolean) => React.ReactNode;
  availableTypesForGroup: (groupType: PaneGroupType, groupId: string) => PaneType[];
  contextPercent?: Record<string, number>;
  onContextRingClick?: (paneId: string) => void;
  onStopStreaming?: (paneId: string) => void;
  onSettings?: (paneId: string) => void;
  onPopOut?: (paneId: string) => void;
  onPinPane?: (groupId: string, paneId: string) => void;
}


export function GroupLayout({
  panes, groups, rows, rowHeights, focusedGroupId, dndScope, isAppFocused = true,
  onActivatePane, onClosePane, onClosePaneImmediate, onAddPaneToGroup, onNewChatInGroup, onAddPaneWhenEmpty, onReorderGroupPanes,
  onMovePaneBetweenGroups, onSplitGroup, onReorderRows,
  onUpdateRows, onUpdateRowHeights,
  renderPane, availableTypesForGroup, contextPercent, onContextRingClick, onStopStreaming,
  onSettings, onPopOut, onPinPane,
}: GroupLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Track drag-ghost DOM nodes so they can be drained on unmount. The rAF that
  // removes a ghost can be throttled indefinitely on a backgrounded tab, so a
  // ghost appended to document.body would otherwise accumulate across drags.
  // Mirrors PanelGrid's "ISSUE 19 FIX".
  const activeGhostsRef = useRef<Set<HTMLElement>>(new Set());
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional unmount-time read: activeGhostsRef holds one stable Set (never reassigned, only mutated); cleanup must drain whatever ghosts are live AT unmount
      for (const ghost of activeGhostsRef.current) {
        if (ghost.parentElement) ghost.parentElement.removeChild(ghost);
      }
      activeGhostsRef.current.clear();
    };
  }, []);

  const { getBadgeCount, clearPane } = useTabNotifications();

  const paneMap = useMemo(() => {
    const m = new Map<string, Pane>();
    for (const p of panes) m.set(p.id, p);
    return m;
  }, [panes]);

  const groupMap = useMemo(() => {
    const m = new Map<string, PaneGroup>();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  // Split mini-map descriptor: real column widths per row + row heights, so the
  // schematic mirrors the actual split proportions. Passed to each group's tab
  // bar; it lights its own cell. Only meaningful with more than one cell — a
  // single group has nothing to orient against.
  const splitRowWidths = useMemo(() => rows.map((r) => r.widths), [rows]);
  const totalCells = useMemo(() => splitRowWidths.reduce((a, r) => a + r.length, 0), [splitRowWidths]);
  const hasSplit = totalCells > 1;

  // Keep-alive: track which panes have ever been activated. Once a pane is
  // visited we keep its React subtree mounted (just hidden via display:none
  // when not active) so the user doesn't see chat history re-fetches, scroll
  // resets, or draft loss every time they switch tabs. Pruned when a pane is
  // closed (no longer present in `panes`). Only the active pane is visible
  // at any time, so the user-visible behavior is unchanged.
  //
  // Tracked by `stableKey` — not `id` — so PANE_ID_REMAP (draft → real
  // topic promotion changes the pane's `id` while keeping `stableKey`)
  // doesn't drop the pane from the visited set and force a remount of
  // its content (which would re-run loadHistory, blow away scroll, etc.).
  const stableKeyOf = useCallback((p: Pane) => p.stableKey ?? p.id, []);
  const [visitedKeys, setVisitedKeys] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    const lookup = new Map(panes.map((p) => [p.id, p]));
    for (const g of groups) {
      const p = g.activePaneId ? lookup.get(g.activePaneId) : undefined;
      if (p) initial.add(p.stableKey ?? p.id);
    }
    return initial;
  });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- accumulates visited-pane history across renders (keep-alive); can't be derived purely in render. Guarded by `changed` and returns `prev` when nothing changed, so it converges and never loops.
    setVisitedKeys((prev) => {
      const next = new Set(prev);
      let changed = false;
      // Add the currently-active pane in each group (visit-on-activation).
      for (const g of groups) {
        const p = g.activePaneId ? paneMap.get(g.activePaneId) : undefined;
        if (!p) continue;
        const k = stableKeyOf(p);
        if (!next.has(k)) {
          next.add(k);
          changed = true;
        }
      }
      // Drop keys for panes that no longer exist (closed/reaped).
      const liveKeys = new Set(panes.map(stableKeyOf));
      for (const k of next) {
        if (!liveKeys.has(k)) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups, panes, paneMap, stableKeyOf]);

  const callbacks = useMemo(() => ({
    onHorizontalResize: (rowIdx: number, _divIdx: number, newWidths: number[]) => {
      const newRows = rows.map((r, i) => i === rowIdx ? { ...r, widths: newWidths } : r);
      onUpdateRows(newRows);
    },
    onVerticalResize: (_divIdx: number, newHeights: number[]) => {
      onUpdateRowHeights(newHeights);
    },
  }), [rows, onUpdateRows, onUpdateRowHeights]);

  // ISSUE 24 FIX: Use data attributes instead of unsafe DOM tree navigation.
  // Dividers carry data-divider-row and data-divider-col; group wrappers carry data-group-cell.
  // This avoids breakage if React reconciliation reorders elements.
  const resizeOptions = useMemo(() => ({
    resolveHorizontal: (divider: HTMLElement) => {
      const rowIdx = divider.getAttribute('data-divider-row');
      const colIdx = divider.getAttribute('data-divider-col');
      if (rowIdx == null || colIdx == null) return null;
      const container = containerRef.current;
      if (!container) return null;
      const leftCol = parseInt(colIdx, 10);
      const rightCol = leftCol + 1;
      const left = container.querySelector(`[data-group-cell="${rowIdx}-${leftCol}"]`) as HTMLElement;
      const right = container.querySelector(`[data-group-cell="${rowIdx}-${rightCol}"]`) as HTMLElement;
      if (!left || !right) return null;
      return { apply: (l: number, r: number) => { left.style.width = `${l * 100}%`; right.style.width = `${r * 100}%`; } };
    },
    resolveVertical: (divider: HTMLElement) => {
      const rowIdx = divider.getAttribute('data-divider-row');
      if (rowIdx == null) return null;
      const container = containerRef.current;
      if (!container) return null;
      const topIdx = parseInt(rowIdx, 10);
      const bottomIdx = topIdx + 1;
      const top = container.querySelector(`[data-group-row="${topIdx}"]`) as HTMLElement;
      const bottom = container.querySelector(`[data-group-row="${bottomIdx}"]`) as HTMLElement;
      if (!top || !bottom) return null;
      return { apply: (t: number, b: number) => { top.style.flex = `${t} 1 0%`; bottom.style.flex = `${b} 1 0%`; } };
    },
  }), []);

  const { startHorizontalResize, startVerticalResize, equalizeHorizontal, equalizeVertical } = useGridResize(containerRef, callbacks, resizeOptions);

  /* ---- Edge drop zone state (Phase 3: split-on-edge-drop) ---- */
  const [edgeDropTarget, setEdgeDropTarget] = useState<{ groupId: string; edge: EdgeZone } | null>(null);
  // Ref mirror so the drop handler always sees the latest target — React
  // state from `setEdgeDropTarget` may not be committed yet when `drop`
  // fires in the same frame as `dragover`, causing fast drops to silently
  // no-op (the "drop twice to land" bug).
  const edgeDropTargetRef = useRefMirror(edgeDropTarget);

  const handleGroupContentDragOver = useCallback((groupId: string) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Scope guard: only this project's tabs may split its groups — a foreign
    // tab gets no edge overlay (and no preventDefault, so it can't drop here).
    if (!dragMatchesScope(e.dataTransfer.types, dndScope)) return;
    const sourceGroupId = e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP) ? 'other' : null;
    if (!sourceGroupId) return; // only show edge zones for cross-group drags

    e.preventDefault();
    e.stopPropagation();

    if (!onSplitGroup) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // 4-zone (no center) — within a group's content area we only care about
    // edges; the center area is owned by the active pane content / tab bar.
    const edge = detectDropZone(e, rect, 'edges') as EdgeZone | null;

    if (edge) {
      const next = { groupId, edge };
      edgeDropTargetRef.current = next;
      setEdgeDropTarget(next);
    } else {
      if (edgeDropTargetRef.current?.groupId === groupId) {
        edgeDropTargetRef.current = null;
        setEdgeDropTarget(null);
      }
    }
  }, [onSplitGroup, edgeDropTargetRef, dndScope]);

  // When a cross-group tab drag moves over THIS group's tab bar (a sibling of
  // the content area), the user is aiming to drop the tab INTO the bar — not to
  // split the group. The edge "area" overlay can have been painted moments
  // earlier, while the pointer transited the content's top edge band on its way
  // up to the bar, and a missed `dragleave` (common on a fast drag or in the
  // frame right before a drop) would leave it stuck. Clearing on every tab-bar
  // dragover guarantees the preview is gone while the pointer is over the bar —
  // so it can't show "split here" when you only want a tab, and can't survive
  // the drop. We never preventDefault here: PaneTabBar still owns the drop.
  // Wired in the CAPTURE phase — PaneTabBar's per-tab dragover calls
  // stopPropagation, so a bubble-phase handler on this wrapper would be skipped
  // exactly when the pointer is over a tab (the common aim). Capture runs
  // top-down before that, so the clear fires for every dragover in the bar.
  const handleTabBarDragOver = useCallback((groupId: string) => () => {
    if (edgeDropTargetRef.current?.groupId === groupId) {
      edgeDropTargetRef.current = null;
      setEdgeDropTarget(null);
    }
  }, [edgeDropTargetRef]);

  const handleGroupContentDragLeave = useCallback((groupId: string) => (e: React.DragEvent) => {
    // Ignore a dragleave that merely crossed into a child of the content area
    // (the pane body) — only clear when the pointer actually left, or the edge
    // preview flickers while dragging over the content.
    const rt = e.relatedTarget as Node | null;
    if (rt && (e.currentTarget as HTMLElement).contains(rt)) return;
    if (edgeDropTargetRef.current?.groupId === groupId) {
      edgeDropTargetRef.current = null;
      setEdgeDropTarget(null);
    }
  }, [edgeDropTargetRef]);

  // True while a same-scope tab is being dragged anywhere over this layout —
  // gates the full-width drop strips so they only intercept events during a
  // drag (otherwise their top/bottom bands would swallow normal clicks on the
  // first row's tab bar). Set on the container's capture-phase dragenter,
  // cleared by resetDndOverlays (window dragend/drop). Declared here, above
  // handleGroupContentDrop, so the setter isn't referenced before its
  // declaration (react-hooks/no-use-before-declare).
  const [dragActive, setDragActive] = useState(false);

  const handleGroupContentDrop = useCallback((groupId: string) => (e: React.DragEvent) => {
    // Validate this is a tab drop before consuming the event.
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    if (!sourcePaneId || !sourceGroupId) return;
    // Scope guard: reject a tab from another window/project on drop too.
    const sourceScope = e.dataTransfer.getData(DND_TYPES.PANE_TAB_SCOPE);
    if (dndScope && sourceScope && sourceScope !== dndScope) return;

    // Prefer the cached target from the latest dragover (ref to dodge React
    // commit lag), but if the user wobbled out of the edge zone in the last
    // few pixels before release the cache may be null/stale — fall back to
    // recomputing from the drop coordinates so a drop anywhere inside an
    // edge band still splits.
    let edge: EdgeZone | null = null;
    const cached = edgeDropTargetRef.current;
    if (cached && cached.groupId === groupId && cached.edge) {
      edge = cached.edge;
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      edge = detectDropZone(e, rect, 'edges') as EdgeZone | null;
    }
    // No edge → not a split drop. Still clear any overlay this group painted so
    // a dead-center release doesn't leave the preview stuck.
    if (!edge) { edgeDropTargetRef.current = null; setEdgeDropTarget(null); return; }

    e.preventDefault();
    e.stopPropagation();

    onSplitGroup?.(sourceGroupId, sourcePaneId, groupId, edge);
    edgeDropTargetRef.current = null;
    setEdgeDropTarget(null);
    // Same leak as handleFullRowDrop: stopPropagation + onSplitGroup reparenting
    // the source defeats both the window 'drop' reset and 'dragend', so the
    // full-width strips (gated on dragActive) would stay painted after an
    // edge-split drop too. Clear it here.
    setDragActive(false);
  }, [onSplitGroup, edgeDropTargetRef, dndScope]);

  /* ---- Cross-group tab drop handler ---- */
  const handleCrossGroupDrop = useCallback((targetGroupId: string) =>
    (sourcePaneId: string, sourceGroupId: string, insertIdx: number) => {
      onMovePaneBetweenGroups?.(sourceGroupId, targetGroupId, sourcePaneId, insertIdx);
    }, [onMovePaneBetweenGroups]);

  /* ---- Full-width row drop strips (split "in basso/in alto a TUTTE le tab") ----
   * The per-cell top/bottom edges split a SINGLE column (cellStacks). To still
   * offer the full-width row — a new row spanning every column — we paint two
   * thin strips at the container's extreme top and bottom that only light up
   * during a cross-group tab drag. Dropping there calls onSplitGroup with
   * `fullRow: true` (no target group needed; the handler inserts above the
   * first / below the last row). */
  const [fullRowDrop, setFullRowDrop] = useState<'top' | 'bottom' | null>(null);
  const fullRowDropRef = useRefMirror(fullRowDrop);

  const isPaneTabDrag = useCallback((e: React.DragEvent) =>
    e.dataTransfer.types.includes(DND_TYPES.PANE_TAB) &&
    e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP) &&
    dragMatchesScope(e.dataTransfer.types, dndScope), [dndScope]);

  const handleFullRowDragOver = useCallback((side: 'top' | 'bottom') => (e: React.DragEvent) => {
    if (!onSplitGroup || !isPaneTabDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // The strip sits over a cell's edge band — clear that per-cell preview so
    // only ONE intent (full-width) shows while the pointer is on the strip.
    if (edgeDropTargetRef.current) { edgeDropTargetRef.current = null; setEdgeDropTarget(null); }
    if (fullRowDropRef.current !== side) { fullRowDropRef.current = side; setFullRowDrop(side); }
  }, [onSplitGroup, isPaneTabDrag, edgeDropTargetRef, fullRowDropRef]);

  const handleFullRowDragLeave = useCallback((e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null;
    if (rt && (e.currentTarget as HTMLElement).contains(rt)) return;
    fullRowDropRef.current = null;
    setFullRowDrop(null);
  }, [fullRowDropRef]);

  const handleFullRowDrop = useCallback((side: 'top' | 'bottom') => (e: React.DragEvent) => {
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    fullRowDropRef.current = null;
    setFullRowDrop(null);
    // This handler stopPropagation()s the drop (below) AND onSplitGroup reparents
    // the dragged tab — so neither the window 'drop' reset nor 'dragend' fires.
    // Clear dragActive here or the "Full-width row" strips stay painted forever.
    setDragActive(false);
    if (!sourcePaneId || !sourceGroupId) return;
    const sourceScope = e.dataTransfer.getData(DND_TYPES.PANE_TAB_SCOPE);
    if (dndScope && sourceScope && sourceScope !== dndScope) return;
    e.preventDefault();
    e.stopPropagation();
    // targetGroupId '' → handler falls back to first/last row for the new row.
    onSplitGroup?.(sourceGroupId, sourcePaneId, '', side, { fullRow: true });
  }, [onSplitGroup, dndScope, fullRowDropRef]);

  /* ---- Row drag reordering (Phase 5) ---- */
  const [draggingRowIdx, setDraggingRowIdx] = useState<number | null>(null);
  const [rowDropTarget, setRowDropTarget] = useState<{ idx: number; side: 'top' | 'bottom' } | null>(null);

  const handleRowDragStart = useCallback((rowIdx: number) => (e: React.DragEvent) => {
    if (!onReorderRows) return;
    setDraggingRowIdx(rowIdx);
    e.dataTransfer.setData(DND_TYPES.LAYOUT_ROW, String(rowIdx));
    e.dataTransfer.effectAllowed = 'move';

    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position:fixed;left:-9999px;top:-9999px;
      padding:4px 12px;border-radius:6px;
      background:color-mix(in srgb, var(--primary) 80%, transparent);color:#fff;
      font:500 12px/1 Inter,system-ui,sans-serif;
      box-shadow:0 2px 8px rgba(0,0,0,0.15);
      white-space:nowrap;pointer-events:none;
    `;
    ghost.textContent = `Row ${rowIdx + 1}`;
    document.body.appendChild(ghost);
    activeGhostsRef.current.add(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => {
      if (ghost.parentElement) document.body.removeChild(ghost);
      activeGhostsRef.current.delete(ghost);
    });
  }, [onReorderRows]);

  const handleRowDragOver = useCallback((rowIdx: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.LAYOUT_ROW)) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const yRatio = (e.clientY - rect.top) / rect.height;
    const side = yRatio < 0.5 ? 'top' : 'bottom';
    setRowDropTarget({ idx: rowIdx, side });
  }, []);

  const handleRowDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourceIdxStr = e.dataTransfer.getData(DND_TYPES.LAYOUT_ROW);
    if (!sourceIdxStr || !rowDropTarget || !onReorderRows) return;

    const sourceIdx = parseInt(sourceIdxStr, 10);
    if (isNaN(sourceIdx)) return;

    const order = rows.map((_, i) => i);
    const removed = order.splice(sourceIdx, 1)[0];
    let targetIdx = rowDropTarget.idx;
    if (sourceIdx < rowDropTarget.idx) targetIdx--;
    if (rowDropTarget.side === 'bottom') targetIdx++;
    order.splice(targetIdx, 0, removed);

    onReorderRows(order);
    setDraggingRowIdx(null);
    setRowDropTarget(null);
  }, [rows, rowDropTarget, onReorderRows]);

  // One reset for every drag-end path: a clean drop, an escape-cancel, a drop
  // outside any zone, or a flaky boundary. Clears BOTH the edge-split preview
  // and the row-drag indicators. The container's onDragEnd only fires when the
  // drag started inside this subtree; the window listener catches every other
  // case, so no overlay is ever left painted after the gesture — the same
  // belt-and-suspenders pattern PaneTabBar uses for its tab indicators.
  const resetDndOverlays = useCallback(() => {
    edgeDropTargetRef.current = null;
    setEdgeDropTarget(null);
    setDraggingRowIdx(null);
    setRowDropTarget(null);
    fullRowDropRef.current = null;
    setFullRowDrop(null);
    setDragActive(false);
  }, [edgeDropTargetRef, fullRowDropRef]);

  // Reset on dragend OR drop. A cross-group move unmounts the dragged tab
  // synchronously inside its drop handler, and the browser then never fires
  // `dragend` on the now-detached source element — so a dragend-only reset
  // leaves the edge-split preview (painted while the drag passed over this
  // group's content) stuck on screen. The `drop` event still bubbles to the
  // window (the tab-bar drop doesn't stopPropagation), so listening for it too
  // guarantees the overlay clears even when dragend is swallowed.
  useEffect(() => {
    const onEnd = () => resetDndOverlays();
    window.addEventListener('dragend', onEnd);
    window.addEventListener('drop', onEnd);
    return () => {
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('drop', onEnd);
    };
  }, [resetDndOverlays]);

  if (rows.length === 0) {
    const emptyAvailableTypes = availableTypesForGroup('chat', '');
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Match the populated branch's chrome row (h-10) so the empty
            project tab bar aligns with the sidebar header. */}
        <div className="chrome-glass flex items-center h-10 border-b border-app-border flex-shrink-0 overflow-hidden min-w-0">
          <div className="flex-1 flex items-center min-w-0 overflow-hidden">
            <PaneTabBar
              panes={[]}
              activePaneId={null}
              onActivate={() => {}}
              onClose={() => {}}
              onAddPane={(type, subType) => (onAddPaneWhenEmpty ?? (() => {}))(type, subType)}
              availableTypes={emptyAvailableTypes}
              dndScope={dndScope}
              onNewChat={onNewChatInGroup ? () => onNewChatInGroup('') : undefined}
            />
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-app-text-muted">
          <div className="text-sm">No chats open</div>
          {onNewChatInGroup && (
            <button
              onClick={() => onNewChatInGroup('')}
              className="px-3 py-1.5 text-xs rounded-md bg-app-surface border border-app-border hover:bg-app-hover transition-colors text-app-text"
            >
              New Chat
            </button>
          )}
        </div>
      </div>
    );
  }

  // Render one group's "block" — its tab bar + active-pane content — reused for
  // a column's primary group AND for each group vertically stacked under it via
  // cellStacks. `rowIdx`/`groupIdx` only feed the split mini-map's active cell
  // (column-level); stacked members share their column's groupIdx. `seenPaneIds`
  // is threaded so a duplicated pane id never paints twice.
  const renderGroupBlock = (gid: string, rowIdx: number, groupIdx: number, seenPaneIds: Set<string>): React.ReactNode => {
    const group = groupMap.get(gid);
    if (!group) return null;
    const groupPanes = group.paneIds
      .map(id => paneMap.get(id))
      .filter((p): p is Pane => !!p && !seenPaneIds.has(p.id));
    for (const p of groupPanes) seenPaneIds.add(p.id);
    const groupNotifications = new Map<string, number>();
    for (const p of groupPanes) {
      const c = getBadgeCount(p.id, p.topicId, p.id === group.activePaneId);
      if (c > 0) groupNotifications.set(p.id, c);
    }
    const isFocusedGroup = focusedGroupId === gid;
    // Tri-state for the active tab + content ring:
    //  - fully focused: project is App-focused AND this is the focused group
    //  - dimmed-active: this is the focused group inside the project, but
    //    the project itself sits next to a focused sibling at App level
    //  - inactive: not the focused group of this project
    const isFullyFocused = isFocusedGroup && isAppFocused;
    const edgeDrop = edgeDropTarget?.groupId === gid ? edgeDropTarget.edge : null;
    return (
      <div data-split-card className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        {/* Per-group tab bar — h-10 to match the project sidebar header
            and the StandaloneChatGroup header (consistent chrome row). */}
        <div className="chrome-glass flex items-center h-10 border-b border-app-border flex-shrink-0 overflow-hidden min-w-0" onDragOverCapture={handleTabBarDragOver(gid)}>
          <div className="flex-1 flex items-center min-w-0 overflow-hidden">
          <PaneTabBar
            panes={groupPanes}
            activePaneId={group.activePaneId}
            groupIsFocused={isFocusedGroup}
            groupIsAppFocused={isFullyFocused}
            onActivate={(paneId) => { clearPane(paneId); onActivatePane(gid, paneId); }}
            onClose={(paneId) => onClosePane(gid, paneId)}
            onCloseImmediate={onClosePaneImmediate ? (paneId) => onClosePaneImmediate(gid, paneId) : undefined}
            onAddPane={(type, subType) => onAddPaneToGroup(gid, type, subType)}
            availableTypes={availableTypesForGroup(group.type, gid)}
            groupType={group.type}
            groupId={gid}
            dndScope={dndScope}
            // "New Chat" is always offered in project tab bars
            // regardless of group.type. Previously gated to
            // `group.type === 'chat'`, which hid the entry from
            // file/browser/git/board groups — the user couldn't
            // create a project chat from them at all. The
            // handler routes the new chat into the project's
            // existing chat group (or creates one) — it does
            // NOT add a chat into a non-chat group.
            onNewChat={onNewChatInGroup
              ? () => onNewChatInGroup(gid)
              : undefined
            }
            onReorderPanes={onReorderGroupPanes
              ? (newPaneIds) => onReorderGroupPanes(gid, newPaneIds)
              : undefined
            }
            onCrossGroupDrop={onMovePaneBetweenGroups
              ? handleCrossGroupDrop(gid)
              : undefined
            }
            onEdgeSplitDrop={onSplitGroup
              ? (sourcePaneId, sourceGroupId, edge) => onSplitGroup(sourceGroupId, sourcePaneId, gid, edge)
              : undefined
            }
            onSplitRight={onSplitGroup
              ? (paneId) => onSplitGroup(gid, paneId, gid, 'right')
              : undefined
            }
            // "Split Down" mirrors the cell bottom-edge drop: a SINGLE-COLUMN
            // vertical stack (under just this column), not a full-width row.
            onSplitDown={onSplitGroup
              ? (paneId) => onSplitGroup(gid, paneId, gid, 'bottom')
              : undefined
            }
            contextPercent={contextPercent}
            onContextRingClick={onContextRingClick}
            onStopStreaming={onStopStreaming}
            onSettings={onSettings}
            onPopOut={onPopOut}
            onPinPane={onPinPane ? (paneId) => onPinPane(gid, paneId) : undefined}
            tabNotifications={groupNotifications}
            splitMap={hasSplit ? { rows: splitRowWidths, rowHeights, active: [rowIdx, groupIdx] } : undefined}
          />
          </div>
        </div>
        {/* Active pane content */}
        <div
          className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative"
          onMouseDownCapture={() => {
            if (!isFocusedGroup && group.activePaneId) {
              onActivatePane(gid, group.activePaneId);
            }
          }}
          onDragOver={handleGroupContentDragOver(gid)}
          onDragLeave={handleGroupContentDragLeave(gid)}
          onDrop={handleGroupContentDrop(gid)}
        >
          {(() => {
            // Keep-alive render: every pane that has been visited
            // stays mounted; only the active one is visible. This
            // preserves chat scroll, history caches, terminal
            // buffers, and form drafts across tab switches —
            // before this, switching tabs unmounted the active
            // pane and re-mounted it from scratch, so users saw
            // a "reload" flicker (re-fetched history, lost
            // scroll, etc.) every time they came back.
            //
            // Always include the currently-active pane even if
            // `visitedKeys` hasn't caught up yet — the visited
            // set is updated in a useEffect that runs *after*
            // render, so on the first render after activation
            // we'd otherwise show the empty-state for one frame.
            // Using `stableKey` as the React key (not pane.id)
            // keeps the subtree mounted across PANE_ID_REMAP.
            const visiblePanes = groupPanes.filter(
              (p) => visitedKeys.has(stableKeyOf(p)) || p.id === group.activePaneId,
            );
            if (visiblePanes.length === 0) {
              return (
                <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">
                  No pane selected
                </div>
              );
            }
            return visiblePanes.map((pane) => {
              const isPaneActive = pane.id === group.activePaneId;
              return (
                <div
                  key={stableKeyOf(pane)}
                  // Content panes paint their own opaque bg so they stay crisp once
                  // the shared backdrop (#main-content) is transparent under Electron
                  // vibrancy. `project` and `terminal` panes stay transparent here so
                  // they ride exactly ONE extra glass layer over the shared group-cell
                  // backdrop (which is itself .chrome-glass): the project sidebar's
                  // own .chrome-glass, or the terminal container's own .chrome-glass.
                  // Adding glass here too would stack a third layer and darken the
                  // terminal relative to the sidebar.
                  className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${pane.type === 'project' || pane.type === 'terminal' ? '' : 'bg-surface'}`}
                  style={{ display: isPaneActive ? 'flex' : 'none' }}
                  aria-hidden={!isPaneActive}
                >
                  {renderPane(pane, isFocusedGroup && isPaneActive, isPaneActive)}
                </div>
              );
            });
          })()}

          {/* Edge drop zone overlays (Phase 3) */}
          {edgeDrop && (
            <div
              className="absolute pointer-events-none z-30"
              style={{
                top: edgeDrop === 'top' ? 0 : edgeDrop === 'bottom' ? '50%' : 0,
                bottom: edgeDrop === 'bottom' ? 0 : edgeDrop === 'top' ? '50%' : 0,
                left: edgeDrop === 'left' ? 0 : edgeDrop === 'right' ? '50%' : 0,
                right: edgeDrop === 'right' ? 0 : edgeDrop === 'left' ? '50%' : 0,
                background: 'color-mix(in srgb, var(--primary) 15%, transparent)',
                border: '2px dashed var(--primary)',
                borderRadius: '4px',
              }}
            />
          )}
        </div>
      </div>
    );
  };

  // Defensive render-time dedup: never paint the same group or pane twice, even
  // if a duplicated id slips into state from a hydrate or split race. The
  // reducers PREVENT new duplicates but don't scrub a list that arrives already
  // duplicated, so a group listed in two rows (or a pane in two groups) would
  // render its whole window/content twice — the "two windows in one window"
  // symptom. These Sets guarantee one logical window per id at the last mile.
  // Purely subtractive (by exact id), so it can only ever show fewer, never more.
  const seenGroupIds = new Set<string>();
  const seenPaneIds = new Set<string>();
  // The full-width drop strips (split "in basso/in alto a TUTTE le tab") only
  // make sense when there's more than one column somewhere — with a single
  // column a per-cell vertical split already spans the full width, so the
  // distinction (and the strips) would be redundant.
  const hasMultipleColumns = rows.some((r) => r.groupIds.length > 1);
  const showFullRowStrips = dragActive && hasMultipleColumns && !!onSplitGroup;

  return (
    <div
      ref={containerRef}
      data-split-surface
      className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative"
      onDragEnd={resetDndOverlays}
      onDragEnterCapture={(e) => { if (isPaneTabDrag(e)) setDragActive(true); }}
    >
      {/* Full-width row drop strips — only live mid-drag (dragActive) so their
          top/bottom bands never swallow normal clicks on the first row's tab
          bar. Dropping here inserts a NEW row spanning every column. */}
      {showFullRowStrips && (['top', 'bottom'] as const).map((side) => (
        <div
          key={side}
          className="absolute left-0 right-0 z-40 flex items-center justify-center transition-colors"
          style={{
            [side]: 0,
            height: 26,
            background: fullRowDrop === side
              ? 'color-mix(in srgb, var(--primary) 22%, transparent)'
              : 'color-mix(in srgb, var(--primary) 6%, transparent)',
            borderTop: side === 'bottom' ? '2px dashed var(--primary)' : undefined,
            borderBottom: side === 'top' ? '2px dashed var(--primary)' : undefined,
            opacity: fullRowDrop === side ? 1 : 0.65,
          }}
          onDragOver={handleFullRowDragOver(side)}
          onDragLeave={handleFullRowDragLeave}
          onDrop={handleFullRowDrop(side)}
        >
          <span className="text-[10px] font-medium text-primary/80 pointer-events-none select-none uppercase tracking-wide">
            Full-width row
          </span>
        </div>
      ))}
      {rows.map((row, rowIdx) => {
        const isDraggingRow = draggingRowIdx === rowIdx;
        const isRowDropTop = rowDropTarget?.idx === rowIdx && rowDropTarget?.side === 'top';
        const isRowDropBottom = rowDropTarget?.idx === rowIdx && rowDropTarget?.side === 'bottom';

        return (
          <div
            key={rowIdx}
            data-group-row={rowIdx}
            className={`flex flex-col min-h-0 ${isDraggingRow ? 'opacity-40' : ''}`}
            style={{ flex: `${rowHeights[rowIdx] ?? 1 / rows.length} 1 0%` }}
          >
            <div
              className="flex flex-1 min-h-0 min-w-0 overflow-hidden relative"
              style={{
                boxShadow: isRowDropTop ? `inset 0 4px 0 0 var(--primary)` : isRowDropBottom ? `inset 0 -4px 0 0 var(--primary)` : undefined,
              }}
              onDragOver={handleRowDragOver(rowIdx)}
              onDrop={handleRowDrop}
            >
              {/* Row drag handle (Phase 5) */}
              {onReorderRows && rows.length > 1 && (
                <div
                  className="absolute left-0 top-0 w-3 h-full z-20 cursor-grab active:cursor-grabbing flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
                  draggable
                  onDragStart={handleRowDragStart(rowIdx)}
                  title={`Drag to reorder row ${rowIdx + 1}`}
                >
                  <div className="w-1 h-6 bg-app-text-tertiary/40 rounded-full" />
                </div>
              )}
              {row.groupIds.map((groupId, groupIdx) => {
                const group = groupMap.get(groupId);
                if (!group || seenGroupIds.has(groupId)) return null;
                seenGroupIds.add(groupId);

                // This column's vertical sub-stack: the groups stacked UNDER the
                // primary (split "in basso a una singola split tab"). Skip any
                // missing / already-painted group and mark survivors seen so a
                // stacked group never also renders as its own top-level column.
                const rawStack = row.cellStacks?.[groupId];
                const stackedIds = (rawStack?.groupIds ?? []).filter(
                  (id) => groupMap.has(id) && !seenGroupIds.has(id),
                );
                for (const id of stackedIds) seenGroupIds.add(id);
                const subStack = stackedIds.length > 0
                  ? { items: stackedIds, heights: rawStack?.heights ?? [] }
                  : undefined;

                return (
                  <div
                    key={groupId}
                    data-group-cell={`${rowIdx}-${groupIdx}`}
                    className="flex min-h-0 min-w-0 overflow-hidden"
                    // Fallback mirrors the row-height style above: a widths array
                    // shorter than groupIds would otherwise yield `width: NaN%`
                    // and collapse the cell.
                    style={{ width: `${(row.widths[groupIdx] ?? 1 / row.groupIds.length) * 100}%` }}
                  >
                    {/* Column body: the primary group, plus any groups stacked
                        vertically under it (cellStacks) composed via CellSubStack
                        with their own in-cell resize dividers. Sibling columns
                        stay full-height. */}
                    <CellSubStack
                      stack={subStack}
                      primary={renderGroupBlock(groupId, rowIdx, groupIdx, seenPaneIds)}
                      renderStackItem={(stackedId) => renderGroupBlock(stackedId, rowIdx, groupIdx, seenPaneIds)}
                      onResize={(nextHeights) => onUpdateRows(setColumnStackHeights(rows, groupId, nextHeights))}
                    />

                    {/* Horizontal divider between groups in a row */}
                    {groupIdx < row.groupIds.length - 1 && (
                      <div
                        data-divider-row={rowIdx}
                        data-divider-col={groupIdx}
                        className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-10"
                        title="Double-click to equalize widths"
                        onMouseDown={startHorizontalResize(rowIdx, groupIdx, row.widths)}
                        onDoubleClick={equalizeHorizontal(rowIdx, row.groupIds.length)}
                      >
                        <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Vertical divider between rows */}
            {rowIdx < rows.length - 1 && (
              <div
                data-divider-row={rowIdx}
                className="h-[1px] flex-shrink-0 cursor-row-resize relative bg-app-border hover:bg-primary transition-colors z-10"
                title="Double-click to equalize heights"
                onMouseDown={startVerticalResize(rowIdx, rowHeights)}
                onDoubleClick={equalizeVertical(rows.length)}
              >
                <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

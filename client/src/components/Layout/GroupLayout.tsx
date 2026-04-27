import { useRef, useMemo, useState, useCallback } from 'react';
import type { Pane, PaneGroup, PaneGroupType, PaneType, GroupLayoutRow } from '../../types';
import { PaneTabBar } from './PaneTabBar';
import { useGridResize } from '../../hooks/useGridResize';
import { DND_TYPES } from '../../lib/dndTypes';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useRefMirror } from '../../hooks/useRefMirror';
import { detectDropZone, type EdgeZone } from '../../lib/dropZone';

interface GroupLayoutProps {
  panes: Pane[];
  groups: PaneGroup[];
  rows: GroupLayoutRow[];
  rowHeights: number[];
  focusedGroupId: string | null;
  onActivatePane: (groupId: string, paneId: string) => void;
  onClosePane: (groupId: string, paneId: string) => void;
  onAddPaneToGroup: (groupId: string, type: PaneType, subType?: string) => void;
  onNewChatInGroup?: (groupId: string) => void;
  onAddPaneWhenEmpty?: (type: PaneType, subType?: string) => void;
  onReorderGroupPanes?: (groupId: string, newPaneIds: string[]) => void;
  onMovePaneBetweenGroups?: (sourceGroupId: string, targetGroupId: string, paneId: string, insertIdx: number) => void;
  onSplitGroup?: (sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom') => void;
  onReorderRows?: (newRowOrder: number[]) => void;
  onUpdateRows: (rows: GroupLayoutRow[]) => void;
  onUpdateRowHeights: (heights: number[]) => void;
  renderPane: (pane: Pane, isFocused: boolean) => React.ReactNode;
  availableTypesForGroup: (groupType: PaneGroupType, groupId: string) => PaneType[];
  contextPercent?: Record<string, number>;
  onContextRingClick?: (paneId: string) => void;
  streamingPaneIds?: Set<string>;
  onStopStreaming?: (paneId: string) => void;
  onSettings?: (paneId: string) => void;
  onPopOut?: (paneId: string) => void;
  onPinPane?: (groupId: string, paneId: string) => void;
}


export function GroupLayout({
  panes, groups, rows, rowHeights, focusedGroupId,
  onActivatePane, onClosePane, onAddPaneToGroup, onNewChatInGroup, onAddPaneWhenEmpty, onReorderGroupPanes,
  onMovePaneBetweenGroups, onSplitGroup, onReorderRows,
  onUpdateRows, onUpdateRowHeights,
  renderPane, availableTypesForGroup, contextPercent, onContextRingClick, streamingPaneIds, onStopStreaming,
  onSettings, onPopOut, onPinPane,
}: GroupLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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

  const { startHorizontalResize, startVerticalResize } = useGridResize(containerRef, callbacks, resizeOptions);

  /* ---- Edge drop zone state (Phase 3: split-on-edge-drop) ---- */
  const [edgeDropTarget, setEdgeDropTarget] = useState<{ groupId: string; edge: EdgeZone } | null>(null);
  // Ref mirror so the drop handler always sees the latest target — React
  // state from `setEdgeDropTarget` may not be committed yet when `drop`
  // fires in the same frame as `dragover`, causing fast drops to silently
  // no-op (the "drop twice to land" bug).
  const edgeDropTargetRef = useRefMirror(edgeDropTarget);

  const handleGroupContentDragOver = useCallback((groupId: string) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
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
  }, [onSplitGroup, edgeDropTargetRef]);

  const handleGroupContentDragLeave = useCallback((groupId: string) => () => {
    if (edgeDropTargetRef.current?.groupId === groupId) {
      edgeDropTargetRef.current = null;
      setEdgeDropTarget(null);
    }
  }, [edgeDropTargetRef]);

  const handleGroupContentDrop = useCallback((groupId: string) => (e: React.DragEvent) => {
    // Validate this is a tab drop before consuming the event.
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    if (!sourcePaneId || !sourceGroupId) return;

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
    if (!edge) return;

    e.preventDefault();
    e.stopPropagation();

    onSplitGroup?.(sourceGroupId, sourcePaneId, groupId, edge);
    edgeDropTargetRef.current = null;
    setEdgeDropTarget(null);
  }, [onSplitGroup, edgeDropTargetRef]);

  /* ---- Cross-group tab drop handler ---- */
  const handleCrossGroupDrop = useCallback((targetGroupId: string) =>
    (sourcePaneId: string, sourceGroupId: string, insertIdx: number) => {
      onMovePaneBetweenGroups?.(sourceGroupId, targetGroupId, sourcePaneId, insertIdx);
    }, [onMovePaneBetweenGroups]);

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
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    requestAnimationFrame(() => document.body.removeChild(ghost));
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

  const handleRowDragEnd = useCallback(() => {
    setDraggingRowIdx(null);
    setRowDropTarget(null);
  }, []);

  if (rows.length === 0) {
    const emptyAvailableTypes = availableTypesForGroup('chat', '');
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="border-b border-app-border flex-shrink-0">
          <PaneTabBar
            panes={[]}
            activePaneId={null}
            onActivate={() => {}}
            onClose={() => {}}
            onAddPane={(type, subType) => (onAddPaneWhenEmpty ?? (() => {}))(type, subType)}
            availableTypes={emptyAvailableTypes}
            onNewChat={onNewChatInGroup ? () => onNewChatInGroup('') : undefined}
          />
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

  return (
    <div ref={containerRef} className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden" onDragEnd={handleRowDragEnd}>
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
                if (!group) return null;

                const groupPanes = group.paneIds
                  .map(id => paneMap.get(id))
                  .filter((p): p is Pane => !!p);
                const activePane = paneMap.get(group.activePaneId);
                const groupNotifications = new Map<string, number>();
                for (const p of groupPanes) {
                  const c = getBadgeCount(p.id, p.topicId, p.id === group.activePaneId);
                  if (c > 0) groupNotifications.set(p.id, c);
                }
                const isFocusedGroup = focusedGroupId === groupId;
                const edgeDrop = edgeDropTarget?.groupId === groupId ? edgeDropTarget.edge : null;

                return (
                  <div
                    key={groupId}
                    data-group-cell={`${rowIdx}-${groupIdx}`}
                    className="flex min-h-0 min-w-0 overflow-hidden"
                    style={{ width: `${row.widths[groupIdx] * 100}%` }}
                  >
                    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
                      {/* Per-group tab bar */}
                      <div className="border-b border-app-border flex-shrink-0 overflow-hidden min-w-0">
                        <PaneTabBar
                          panes={groupPanes}
                          activePaneId={group.activePaneId}
                          groupIsFocused={isFocusedGroup}
                          onActivate={(paneId) => { clearPane(paneId); onActivatePane(groupId, paneId); }}
                          onClose={(paneId) => onClosePane(groupId, paneId)}
                          onAddPane={(type, subType) => onAddPaneToGroup(groupId, type, subType)}
                          availableTypes={availableTypesForGroup(group.type, groupId)}
                          groupType={group.type}
                          groupId={groupId}
                          onNewChat={group.type === 'chat' && onNewChatInGroup
                            ? () => onNewChatInGroup(groupId)
                            : undefined
                          }
                          onReorderPanes={onReorderGroupPanes
                            ? (newPaneIds) => onReorderGroupPanes(groupId, newPaneIds)
                            : undefined
                          }
                          onCrossGroupDrop={onMovePaneBetweenGroups
                            ? handleCrossGroupDrop(groupId)
                            : undefined
                          }
                          onEdgeSplitDrop={onSplitGroup
                            ? (sourcePaneId, sourceGroupId, edge) => onSplitGroup(sourceGroupId, sourcePaneId, groupId, edge)
                            : undefined
                          }
                          onSplitRight={onSplitGroup
                            ? (paneId) => onSplitGroup(groupId, paneId, groupId, 'right')
                            : undefined
                          }
                          onSplitDown={onSplitGroup
                            ? (paneId) => onSplitGroup(groupId, paneId, groupId, 'bottom')
                            : undefined
                          }
                          contextPercent={contextPercent}
                          onContextRingClick={onContextRingClick}
                          streamingPaneIds={streamingPaneIds}
                          onStopStreaming={onStopStreaming}
                          onSettings={onSettings}
                          onPopOut={onPopOut}
                          onPinPane={onPinPane ? (paneId) => onPinPane(groupId, paneId) : undefined}
                          tabNotifications={groupNotifications}
                        />
                      </div>
                      {/* Active pane content */}
                      <div
                        className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative ${
                          isFocusedGroup ? 'ring-1 ring-inset ring-primary/20' : ''
                        }`}
                        onMouseDownCapture={() => {
                          if (!isFocusedGroup && group.activePaneId) {
                            onActivatePane(groupId, group.activePaneId);
                          }
                        }}
                        onDragOver={handleGroupContentDragOver(groupId)}
                        onDragLeave={handleGroupContentDragLeave(groupId)}
                        onDrop={handleGroupContentDrop(groupId)}
                      >
                        {activePane ? renderPane(activePane, isFocusedGroup) : (
                          <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">
                            No pane selected
                          </div>
                        )}

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

                    {/* Horizontal divider between groups in a row */}
                    {groupIdx < row.groupIds.length - 1 && (
                      <div
                        data-divider-row={rowIdx}
                        data-divider-col={groupIdx}
                        className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-10"
                        onMouseDown={startHorizontalResize(rowIdx, groupIdx, row.widths)}
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
                onMouseDown={startVerticalResize(rowIdx, rowHeights)}
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

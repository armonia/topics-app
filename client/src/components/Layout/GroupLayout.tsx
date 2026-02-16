import { useRef, useMemo } from 'react';
import type { Pane, PaneGroup, PaneGroupType, PaneType, GroupLayoutRow } from '../../types';
import { PaneTabBar } from './PaneTabBar';
import { useGridResize } from '../../hooks/useGridResize';

interface GroupLayoutProps {
  panes: Pane[];
  groups: PaneGroup[];
  rows: GroupLayoutRow[];
  rowHeights: number[];
  focusedGroupId: string | null;
  onActivatePane: (groupId: string, paneId: string) => void;
  onClosePane: (groupId: string, paneId: string) => void;
  onAddPaneToGroup: (groupId: string, type: PaneType) => void;
  onNewChatInGroup?: (groupId: string) => void;
  onReorderGroupPanes?: (groupId: string, newPaneIds: string[]) => void;
  onUpdateRows: (rows: GroupLayoutRow[]) => void;
  onUpdateRowHeights: (heights: number[]) => void;
  renderPane: (pane: Pane, isFocused: boolean) => React.ReactNode;
  availableTypesForGroup: (groupType: PaneGroupType) => PaneType[];
}

export function GroupLayout({
  panes, groups, rows, rowHeights, focusedGroupId,
  onActivatePane, onClosePane, onAddPaneToGroup, onNewChatInGroup, onReorderGroupPanes,
  onUpdateRows, onUpdateRowHeights,
  renderPane, availableTypesForGroup,
}: GroupLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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

  const { startHorizontalResize, startVerticalResize } = useGridResize(containerRef, callbacks);

  return (
    <div ref={containerRef} className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {rows.map((row, rowIdx) => (
        <div key={rowIdx} className="flex flex-col flex-1 min-h-0">
          <div
            className="flex flex-1 min-h-0 min-w-0"
            style={{ flex: `${rowHeights[rowIdx] ?? 1 / rows.length} 1 0%` }}
          >
            {row.groupIds.map((groupId, groupIdx) => {
              const group = groupMap.get(groupId);
              if (!group) return null;

              const groupPanes = group.paneIds
                .map(id => paneMap.get(id))
                .filter((p): p is Pane => !!p);
              const activePane = paneMap.get(group.activePaneId);
              const isFocusedGroup = focusedGroupId === groupId;

              return (
                <div
                  key={groupId}
                  className="flex min-h-0"
                  style={{ width: `${row.widths[groupIdx] * 100}%` }}
                >
                  <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
                    {/* Per-group tab bar */}
                    <div className="border-b border-app-border flex-shrink-0">
                      <PaneTabBar
                        panes={groupPanes}
                        activePaneId={group.activePaneId}
                        onActivate={(paneId) => onActivatePane(groupId, paneId)}
                        onClose={(paneId) => onClosePane(groupId, paneId)}
                        onAddPane={(type) => onAddPaneToGroup(groupId, type)}
                        availableTypes={availableTypesForGroup(group.type)}
                        groupType={group.type}
                        onNewChat={group.type === 'chat' && onNewChatInGroup
                          ? () => onNewChatInGroup(groupId)
                          : undefined
                        }
                        onReorderPanes={onReorderGroupPanes
                          ? (newPaneIds) => onReorderGroupPanes(groupId, newPaneIds)
                          : undefined
                        }
                      />
                    </div>
                    {/* Active pane content */}
                    <div
                      className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${
                        isFocusedGroup ? 'ring-1 ring-inset ring-primary/20' : ''
                      }`}
                    >
                      {activePane ? renderPane(activePane, isFocusedGroup) : (
                        <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">
                          No pane selected
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Horizontal divider between groups in a row */}
                  {groupIdx < row.groupIds.length - 1 && (
                    <div
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
              className="h-[1px] flex-shrink-0 cursor-row-resize relative bg-app-border hover:bg-primary transition-colors z-10"
              onMouseDown={startVerticalResize(rowIdx, rowHeights)}
            >
              <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

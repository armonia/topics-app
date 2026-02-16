import { useRef, useMemo } from 'react';
import type { Pane, PaneLayoutRow } from '../../types';
import { useGridResize } from '../../hooks/useGridResize';

interface PaneLayoutProps {
  panes: Pane[];
  rows: PaneLayoutRow[];
  rowHeights: number[];
  activePaneId: string | null;
  onActivatePane: (paneId: string) => void;
  onUpdateRows: (rows: PaneLayoutRow[]) => void;
  onUpdateRowHeights: (heights: number[]) => void;
  renderPane: (pane: Pane, isActive: boolean) => React.ReactNode;
}

export function PaneLayout({
  panes, rows, rowHeights, activePaneId,
  onActivatePane, onUpdateRows, onUpdateRowHeights,
  renderPane,
}: PaneLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const paneMap = useMemo(() => {
    const m = new Map<string, Pane>();
    for (const p of panes) m.set(p.id, p);
    return m;
  }, [panes]);

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
            {row.panes.map((paneId, paneIdx) => {
              const pane = paneMap.get(paneId);
              if (!pane) return null;
              const isActive = activePaneId === paneId;

              return (
                <div
                  key={paneId}
                  className="flex min-h-0"
                  style={{ width: `${row.widths[paneIdx] * 100}%` }}
                >
                  <div
                    className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${
                      isActive ? 'ring-1 ring-inset ring-primary/20' : ''
                    }`}
                    onClick={() => onActivatePane(paneId)}
                  >
                    {renderPane(pane, isActive)}
                  </div>

                  {/* Horizontal divider between panes in a row */}
                  {paneIdx < row.panes.length - 1 && (
                    <div
                      className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-10"
                      onMouseDown={startHorizontalResize(rowIdx, paneIdx, row.widths)}
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

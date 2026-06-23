import { useCallback, useState } from 'react';
import { DND_TYPES, dragMatchesScope, STANDALONE_SCOPE } from '../../lib/dndTypes';

/**
 * True for a PANE_TAB drag that belongs to a project window (any scope other
 * than the standalone "main" scope). These dividers insert/reorder TOP-LEVEL
 * grid cells, so a project's *internal* tab drag must not light them up — that
 * was the "split border of another project" feedback the user saw while
 * dragging a tab inside one project and grazing the border toward another.
 * GRID_ITEM drags (top-level cell reorder) and standalone tabs are unaffected.
 * Mirrors the scope guard PanelGrid applies to its cell split-area preview.
 */
function isForeignTabDrag(types: readonly string[]): boolean {
  return (
    types.includes(DND_TYPES.PANE_TAB) &&
    !types.includes(DND_TYPES.GRID_ITEM) &&
    !dragMatchesScope(types, STANDALONE_SCOPE)
  );
}

/**
 * Drag-aware divider that sits between two grid cells.
 *
 * Idle state: a 1px hairline rendered identically to the previous static
 * divider (same hover-to-primary tint), so the existing "drag handle to
 * resize" UX is unchanged. The 6px hit-box (via the inner ±3px overlay) is
 * preserved for the resize cursor.
 *
 * Drag-active state (a tab or grid item is being dragged anywhere in the
 * grid): the divider widens its drop target to ±15px and renders a thicker
 * primary-tinted indicator on hover, so the user gets clear feedback that
 * dropping HERE inserts the dragged tab BETWEEN the two adjacent cells.
 *
 * The actual insert math lives in PanelGrid via `onInsertBetween` — this
 * component is a thin event router.
 */

interface ColumnInsertDividerProps {
  rowIdx: number;
  colIdx: number;
  widths: number[];
  isDragActive: boolean;
  onResizeStart: (e: React.MouseEvent) => void;
  /** Double-click → equalize this row's column widths (1/n each). */
  onEqualize?: () => void;
  /**
   * Called when a tab/grid-item is dropped on the divider. The handler
   * receives the (rowIdx, colIdx) of the LEFT cell — the insert point is
   * `colIdx + 1`.
   */
  onInsertBetween: (rowIdx: number, colIdx: number, e: React.DragEvent) => void;
  /**
   * Called while the divider is the active drop target, so the parent grid can
   * clear its per-cell split-region preview. The divider's hit-box (±15px)
   * overlaps the adjacent cell's edge band, so without this the cell's filled
   * region stays painted AND the divider bar shows — two previews at once.
   */
  onClaimDropTarget?: () => void;
}

export function ColumnInsertDivider({
  rowIdx,
  colIdx,
  widths: _widths,
  isDragActive,
  onResizeStart,
  onEqualize,
  onInsertBetween,
  onClaimDropTarget,
}: ColumnInsertDividerProps) {
  const [hoverDuringDrag, setHoverDuringDrag] = useState(false);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDragActive) return;
      const types = e.dataTransfer.types;
      if (!types.includes(DND_TYPES.PANE_TAB) && !types.includes(DND_TYPES.GRID_ITEM)) return;
      // A project's internal tab drag must not light up the top-level split
      // borders (no preventDefault → the project keeps owning the drop).
      if (isForeignTabDrag(types)) return;
      e.preventDefault();
      // stop the surrounding cell's dragover from re-claiming the drop target
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      // Clear the cell's split-region preview so ONLY the divider bar shows.
      onClaimDropTarget?.();
      setHoverDuringDrag(true);
    },
    [isDragActive, onClaimDropTarget],
  );

  const handleDragLeave = useCallback(() => setHoverDuringDrag(false), []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      setHoverDuringDrag(false);
      if (!isDragActive) return;
      const types = e.dataTransfer.types;
      if (!types.includes(DND_TYPES.PANE_TAB) && !types.includes(DND_TYPES.GRID_ITEM)) return;
      if (isForeignTabDrag(types)) return;
      e.preventDefault();
      e.stopPropagation();
      onInsertBetween(rowIdx, colIdx, e);
    },
    [isDragActive, onInsertBetween, rowIdx, colIdx],
  );

  return (
    <div
      className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-10"
      data-panel-divider-row={rowIdx}
      data-panel-divider-col={colIdx}
      title={onEqualize ? 'Double-click to equalize widths' : undefined}
      onMouseDown={onResizeStart}
      onDoubleClick={onEqualize}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Resize hit-box: 6px wide centered on the 1px line */}
      <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
      {/* Drop hit-box: only renders during a drag, 30px wide centered */}
      {isDragActive && (
        <div
          data-insert-divider-col={colIdx}
          className="absolute inset-y-0 -left-[15px] -right-[15px] z-20"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        />
      )}
      {/* Visible drop indicator centered on the divider */}
      {hoverDuringDrag && (
        <div
          aria-hidden
          className="absolute inset-y-0 -left-[2px] -right-[2px] bg-primary rounded-sm pointer-events-none"
          style={{ boxShadow: '0 0 0 1px var(--primary)' }}
        />
      )}
    </div>
  );
}

interface RowInsertDividerProps {
  rowIdx: number;
  isDragActive: boolean;
  onResizeStart: (e: React.MouseEvent) => void;
  /** Double-click → equalize the grid's row heights (1/n each). */
  onEqualize?: () => void;
  /**
   * Called when a tab/grid-item is dropped on the divider. The handler
   * receives the rowIdx of the row ABOVE the divider — the insert point
   * is `rowIdx + 1`.
   */
  onInsertBetween: (rowIdx: number, e: React.DragEvent) => void;
  /** See ColumnInsertDivider.onClaimDropTarget — clears the cell region so only
   *  the divider bar shows while the divider is the active drop target. */
  onClaimDropTarget?: () => void;
}

export function RowInsertDivider({
  rowIdx,
  isDragActive,
  onResizeStart,
  onEqualize,
  onInsertBetween,
  onClaimDropTarget,
}: RowInsertDividerProps) {
  const [hoverDuringDrag, setHoverDuringDrag] = useState(false);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDragActive) return;
      const types = e.dataTransfer.types;
      if (!types.includes(DND_TYPES.PANE_TAB) && !types.includes(DND_TYPES.GRID_ITEM)) return;
      if (isForeignTabDrag(types)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      onClaimDropTarget?.();
      setHoverDuringDrag(true);
    },
    [isDragActive, onClaimDropTarget],
  );

  const handleDragLeave = useCallback(() => setHoverDuringDrag(false), []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      setHoverDuringDrag(false);
      if (!isDragActive) return;
      const types = e.dataTransfer.types;
      if (!types.includes(DND_TYPES.PANE_TAB) && !types.includes(DND_TYPES.GRID_ITEM)) return;
      if (isForeignTabDrag(types)) return;
      e.preventDefault();
      e.stopPropagation();
      onInsertBetween(rowIdx, e);
    },
    [isDragActive, onInsertBetween, rowIdx],
  );

  return (
    <div
      className="h-[1px] flex-shrink-0 cursor-row-resize relative bg-app-border hover:bg-primary transition-colors z-10"
      data-panel-row-divider={rowIdx}
      title={onEqualize ? 'Double-click to equalize heights' : undefined}
      onMouseDown={onResizeStart}
      onDoubleClick={onEqualize}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
      {isDragActive && (
        <div
          data-insert-divider-row={rowIdx}
          className="absolute inset-x-0 -top-[15px] -bottom-[15px] z-20"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        />
      )}
      {hoverDuringDrag && (
        <div
          aria-hidden
          className="absolute inset-x-0 -top-[2px] -bottom-[2px] bg-primary rounded-sm pointer-events-none"
          style={{ boxShadow: '0 0 0 1px var(--primary)' }}
        />
      )}
    </div>
  );
}

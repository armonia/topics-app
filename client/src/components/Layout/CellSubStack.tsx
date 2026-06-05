import { Fragment, useCallback, useState } from 'react';
import type { PanelGridCellStack } from '../../types';
import { equalizeWidths } from './gridWidths';

/**
 * Vertical stack of items inside a single grid cell. The PRIMARY item is
 * passed as the first child (children[0]); additional items in the stack
 * follow as children[1..N]. The heights array drives the flex-grow ratios
 * of each row in the stack — children get rendered in `[primary, ...items]`
 * order with the matching height per slot.
 *
 * The component owns the in-stack vertical-resize divider behavior and
 * notifies the parent via `onResize(newHeights)` when the user drags.
 *
 * If `stack` is undefined (the common case — cell hosts a single pane), we
 * render the primary child directly without any wrapper, so the legacy
 * single-pane render path is unchanged.
 */
export interface CellSubStackProps {
  stack?: PanelGridCellStack;
  primary: React.ReactNode;
  /** Rendered for each item in `stack.items`. Index matches stack.items[i]. */
  renderStackItem: (itemKey: string, idx: number) => React.ReactNode;
  /**
   * Called when the user drags one of the in-cell vertical dividers.
   * `nextHeights` is the new full heights array (length items.length + 1
   * to include the primary slot), summing to 1.
   */
  onResize?: (nextHeights: number[]) => void;
  /** Pass-through for InsertDivider visibility during drag. */
  isDragActive?: boolean;
}

export function CellSubStack({
  stack,
  primary,
  renderStackItem,
  onResize,
  isDragActive: _isDragActive,
}: CellSubStackProps) {
  // No stack — render the primary as before. This branch is the hot path
  // for the vast majority of cells; we deliberately avoid any wrapper
  // elements so the existing flex chain (cell → StandaloneChatGroup) is
  // byte-identical to the pre-substack render.
  if (!stack || stack.items.length === 0) {
    return <>{primary}</>;
  }

  const totalSlots = stack.items.length + 1;
  const heights = stack.heights.length === totalSlots
    ? stack.heights
    : Array.from({ length: totalSlots }, () => 1 / totalSlots);

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
      <div
        className="flex flex-col min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `${heights[0]} 1 0%` }}
      >
        {primary}
      </div>
      {stack.items.map((itemKey, i) => (
        <Fragment key={itemKey}>
          <SubStackResizeDivider
            slotIdx={i}
            heights={heights}
            onResize={onResize}
          />
          <div
            className="flex flex-col min-h-0 min-w-0 overflow-hidden"
            style={{ flex: `${heights[i + 1]} 1 0%` }}
          >
            {renderStackItem(itemKey, i)}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Horizontal divider between adjacent slots in a vertical sub-stack. Drag
 * to redistribute heights between the slot above (slotIdx) and below
 * (slotIdx + 1). Other slots' heights are preserved.
 */
interface SubStackResizeDividerProps {
  slotIdx: number;
  heights: number[];
  onResize?: (nextHeights: number[]) => void;
}

function SubStackResizeDivider({ slotIdx, heights, onResize }: SubStackResizeDividerProps) {
  const [active, setActive] = useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onResize) return;
      e.preventDefault();
      e.stopPropagation();
      setActive(true);

      // Capture parent height at drag start. The divider's parent container
      // (.flex-col around the whole stack) drives proportional sizing, so
      // the absolute pixel delta during drag must be projected back into a
      // fraction of that container's height to update `heights[]`.
      const dividerEl = e.currentTarget as HTMLElement;
      const containerEl = dividerEl.parentElement;
      const containerHeight = containerEl?.getBoundingClientRect().height ?? 1;
      const startY = e.clientY;
      const startTop = heights[slotIdx];
      const startBottom = heights[slotIdx + 1];
      const combined = startTop + startBottom;
      const minSlot = 0.05; // floor — prevents collapsing a slot to zero

      const onMove = (ev: MouseEvent) => {
        const deltaPx = ev.clientY - startY;
        const deltaFrac = deltaPx / containerHeight;
        let nextTop = startTop + deltaFrac;
        let nextBottom = startBottom - deltaFrac;
        if (nextTop < minSlot) {
          nextTop = minSlot;
          nextBottom = combined - minSlot;
        } else if (nextBottom < minSlot) {
          nextBottom = minSlot;
          nextTop = combined - minSlot;
        }
        const next = [...heights];
        next[slotIdx] = nextTop;
        next[slotIdx + 1] = nextBottom;
        onResize(next);
      };
      const onUp = () => {
        setActive(false);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [heights, slotIdx, onResize],
  );

  // Double-click any in-stack divider → reset every slot to an equal height.
  const handleDoubleClick = useCallback(() => {
    if (!onResize || heights.length <= 1) return;
    onResize(equalizeWidths(heights.length));
  }, [onResize, heights.length]);

  return (
    <div
      className={`h-[1px] flex-shrink-0 cursor-row-resize relative bg-app-border hover:bg-primary transition-colors z-10 ${
        active ? 'bg-primary' : ''
      }`}
      title="Double-click to equalize heights"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
    </div>
  );
}

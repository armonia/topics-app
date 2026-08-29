import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { PanelGridCellStack } from '../../types';
import { equalizeWidths } from './gridWidths';
import { MIN_PANE_FRACTION } from './constants';
import { DRAG_SLOP_PX } from '../../hooks/useGridResize';

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
  /**
   * Identity of the primary slot, published as `data-split-leaf` when the cell
   * really hosts a stack. The stack IS a split of that cell along `col`, so
   * without these attributes a top/bottom edge drop changed the layout and
   * left no trace in the tree the DOM publishes (DNDSPLIT-01 asks for every
   * split node to be readable). Absent for hosts that have no key to give:
   * the attributes are then simply not written.
   */
  primaryKey?: string;
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
  primaryKey,
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
    <div
      className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden"
      // Same contract as SplitTree's own nodes: a stack is a `col` split of the
      // hosting cell, with one slot per pane. It lives INSIDE the cell the tree
      // renders as a leaf, so a reader that stops at `data-split-leaf` sees the
      // coarse shape and one that keeps walking sees the finer one.
      data-split-node="col"
      data-split-arity={totalSlots}
    >
      <div
        className="flex flex-col min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `${heights[0]} 1 0%` }}
        data-split-leaf={primaryKey}
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
            data-split-leaf={itemKey}
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
  // Teardown for the in-flight drag, so unmount-mid-drag can finish it.
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onResize) return;
      e.preventDefault();
      e.stopPropagation();
      setActive(true);

      // Same drag chrome as useGridResize: a full-viewport overlay keeps the
      // pointer from being swallowed by iframes (terminal/browser panes), and
      // the 'pane-resize-start'/'-end' pair lets native Electron
      // WebContentsView panes hide for the duration. Listeners count starts
      // vs ends, so teardown must be idempotent and ALWAYS balanced — even
      // when the divider unmounts mid-drag. Raised lazily on the first move
      // beyond DRAG_SLOP_PX — raising it on mousedown would retarget the
      // mouseup to the overlay and double-click → equalize could never fire.
      let overlay: HTMLDivElement | null = null;
      const raiseChrome = () => {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:row-resize';
        document.body.appendChild(overlay);
        window.dispatchEvent(new Event('topics:pane-resize-start'));
      };

      // Capture parent height at drag start. The divider's parent container
      // (.flex-col around the whole stack) drives proportional sizing, so
      // the absolute pixel delta during drag must be projected back into a
      // fraction of that container's height to update `heights[]`.
      const dividerEl = e.currentTarget as HTMLElement;
      const containerEl = dividerEl.parentElement;
      const containerHeight = containerEl?.getBoundingClientRect().height ?? 1;
      // DOM-direct resize: the two slots flanking this divider are its previous
      // / next siblings in the stack's flex column. We mutate their flex-grow
      // inline DURING the drag (zero React re-renders — the pane bodies don't
      // reconcile per mousemove) and commit the final heights to React state
      // ONCE on mouseup. Mirrors useGridResize's DOM-direct path so a sub-stack
      // divider drags as smoothly as a top-level one. Transitions are disabled
      // for the drag so the panes track the cursor 1:1 instead of easing behind.
      const aboveEl = dividerEl.previousElementSibling as HTMLElement | null;
      const belowEl = dividerEl.nextElementSibling as HTMLElement | null;
      const prevAboveTransition = aboveEl?.style.transition ?? '';
      const prevBelowTransition = belowEl?.style.transition ?? '';
      if (aboveEl) aboveEl.style.transition = 'none';
      if (belowEl) belowEl.style.transition = 'none';
      const startY = e.clientY;
      const startTop = heights[slotIdx];
      const startBottom = heights[slotIdx + 1];
      const combined = startTop + startBottom;
      const minSlot = MIN_PANE_FRACTION; // shared floor — prevents collapsing a slot to zero
      // Latest heights computed mid-drag; committed to React once on finish.
      let latestHeights: number[] | null = null;

      const onMove = (ev: MouseEvent) => {
        // Lost-mouseup recovery: button no longer down (released over another
        // app / native view) — finish instead of leaving the overlay armed.
        if ((ev.buttons & 1) === 0) { finish(); return; }
        // Sub-slop jitter while pressed is still a click in progress.
        if (!overlay && Math.abs(ev.clientY - startY) <= DRAG_SLOP_PX) return;
        raiseChrome();
        const deltaFrac = (ev.clientY - startY) / containerHeight;
        let nextTop = startTop + deltaFrac;
        let nextBottom = startBottom - deltaFrac;
        if (nextTop < minSlot) {
          nextTop = minSlot;
          nextBottom = combined - minSlot;
        } else if (nextBottom < minSlot) {
          nextBottom = minSlot;
          nextTop = combined - minSlot;
        }
        // Apply directly to the DOM — no setState, no re-render of pane bodies.
        if (aboveEl) aboveEl.style.flex = `${nextTop} 1 0%`;
        if (belowEl) belowEl.style.flex = `${nextBottom} 1 0%`;
        const next = [...heights];
        next[slotIdx] = nextTop;
        next[slotIdx + 1] = nextBottom;
        latestHeights = next;
      };
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        cleanupRef.current = null;
        setActive(false);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', finish);
        if (aboveEl) aboveEl.style.transition = prevAboveTransition;
        if (belowEl) belowEl.style.transition = prevBelowTransition;
        if (overlay) {
          overlay.remove();
          overlay = null;
          window.dispatchEvent(new Event('topics:pane-resize-end'));
        }
        // Commit the final heights to React ONCE — and only for a real drag.
        // A bare click leaves latestHeights null (no phantom resize), so the
        // double-click → equalize handler isn't pre-empted.
        if (latestHeights) onResize(latestHeights);
      };
      cleanupRef.current = finish;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', finish);
    },
    [heights, slotIdx, onResize],
  );

  // Unmount mid-drag (e.g. the stack collapses while dragging): finish the
  // drag so listeners, overlay and the start/end event count stay balanced.
  useEffect(() => () => { cleanupRef.current?.(); }, []);

  // Double-click any in-stack divider → reset every slot to an equal height.
  const handleDoubleClick = useCallback(() => {
    if (!onResize || heights.length <= 1) return;
    onResize(equalizeWidths(heights.length));
  }, [onResize, heights.length]);

  return (
    <div
      data-resize-axis="row"
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

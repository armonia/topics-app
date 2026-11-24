/**
 * The hand order of the column's rows (lib/listOrder.ts): a drag inside a list
 * places the row, by mouse (HTML5 drag events on the list) or by finger
 * (`placeByFinger`, called by the touch carrier with the release point).
 *
 * A list spreads `listProps(key, rows)` and draws `dropLine(key)`. Its rows
 * are wrapped in `display: contents` boxes carrying `data-order-id`, so the
 * layout does not change and a drop can ask where the rows are.
 */
import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { draggedPaneId } from '@/lib/dragPayload';
import { DND_TYPES } from '@/lib/dndTypes';
import { moveInOrder, ROW_ORDER_DRAG } from '@/lib/listOrder';
import { sidebarItemPaneId, type SidebarItem } from '@/lib/buildSidebarItems';

type ListProps = HTMLAttributes<HTMLDivElement> & { 'data-order-list'?: string };

/** Where a drop at `y` lands in a list: before which row, and the line's offset. */
function slotAt(listEl: HTMLElement, y: number): { before: string | null; top: number } {
  const base = listEl.getBoundingClientRect().top;
  const rows = [...listEl.querySelectorAll<HTMLElement>(':scope > [data-order-id]')];
  let lastBottom = 0;
  for (const w of rows) {
    const r = w.firstElementChild?.getBoundingClientRect();
    if (!r) continue;
    if (y < r.top + r.height / 2) return { before: w.dataset.orderId ?? null, top: r.top - base - 2 };
    lastBottom = r.bottom - base;
  }
  return { before: null, top: lastBottom + 1 };
}

/** The row of `list` the dragged pane stands for, if it belongs to that list. */
function rowFor(paneId: string | null, list: readonly SidebarItem[]): string | null {
  return paneId ? list.find(i => sidebarItemPaneId(i) === paneId || i.id === paneId)?.id ?? null : null;
}

export function useHandOrder({ allItems, listOrder, onListOrderChange, column }: {
  allItems: readonly SidebarItem[];
  listOrder: readonly string[];
  onListOrderChange?: (next: string[]) => void;
  column: RefObject<HTMLElement | null>;
}): {
  listProps: (key: string, list: SidebarItem[]) => ListProps;
  dropLine: (key: string) => ReactNode;
  placeByFinger: (paneId: string, x: number, y: number) => boolean;
} {
  const lists = useRef(new Map<string, SidebarItem[]>());
  const [drop, setDrop] = useState<{ list: string; top: number } | null>(null);
  // The gesture is over however it ended (released, Escape, out of the
  // window): `dragend` reaches window in all three cases.
  useEffect(() => {
    const clear = () => setDrop(null);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  const place = useCallback((list: readonly SidebarItem[], moved: string, before: string | null) => {
    if (!onListOrderChange || moved === before) return;
    const known = new Set(allItems.map(i => i.id));
    onListOrderChange(moveInOrder(list.map(i => i.id), listOrder, moved, before).filter(id => known.has(id)));
  }, [allItems, listOrder, onListOrderChange]);

  const listProps = (key: string, list: SidebarItem[]): ListProps => {
    if (!onListOrderChange) return {};
    lists.current.set(key, list);
    return {
      'data-order-list': key,
      onDragOver: (e) => {
        const types = e.dataTransfer.types;
        if (!(types.includes(DND_TYPES.PANEL_ID) || types.includes(ROW_ORDER_DRAG)) || !rowFor(draggedPaneId(), list)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const { top } = slotAt(e.currentTarget, e.clientY);
        setDrop(prev => (prev?.list === key && prev.top === top ? prev : { list: key, top }));
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      },
      onDrop: (e) => {
        setDrop(null);
        const moved = rowFor(draggedPaneId(), list);
        if (!moved) return;
        e.preventDefault();
        place(list, moved, slotAt(e.currentTarget, e.clientY).before);
      },
    };
  };

  /** The line where a dragged row lands, drawn over the list (no reflow). */
  const dropLine = (key: string): ReactNode => drop?.list === key && (
    <div aria-hidden="true" data-testid="order-drop-line" className="pointer-events-none absolute left-1.5 right-1.5 h-0.5 rounded-full bg-primary" style={{ top: drop.top }} />
  );

  // The finger: a row carried by touch and released over a list is placed
  // there; released anywhere else it goes on to the pins (false).
  const placeByFinger = useCallback((paneId: string, x: number, y: number) => {
    const col = column.current;
    if (!col) return false;
    for (const el of col.querySelectorAll<HTMLElement>('[data-order-list]')) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const list = lists.current.get(el.dataset.orderList ?? '') ?? [];
      const moved = rowFor(paneId, list);
      if (!moved) return false;
      place(list, moved, slotAt(el, y).before);
      return true;
    }
    return false;
  }, [column, place]);

  return { listProps, dropLine, placeByFinger };
}

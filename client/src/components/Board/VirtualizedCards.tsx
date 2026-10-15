import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import type { BoardTask } from '../../lib/board';
import { layoutVirtualRows, visibleVirtualIds, type VirtualRow } from '../../lib/boardVirtualWindow';
import { scrollParentOf } from '../../lib/boardVirtualViewport';

const VIRTUAL_ROW_ESTIMATE = 184;
const VIRTUAL_ROW_GAP = 8;
const VIRTUAL_BUFFER = 360;
const VIRTUAL_FULL_RENDER_LIMIT = 25;

type RenderRow = VirtualRow<BoardTask>;

export function VirtualizedCards({ tasks, activeId, viewport, renderCard }: {
  tasks: BoardTask[];
  activeId?: string | null;
  viewport: { top: number; height: number };
  renderCard: (task: BoardTask) => ReactNode;
}) {
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map());
  const list = useRef<HTMLDivElement>(null);
  // Every measurement, ahead of the committed `heights`: a card measured twice
  // before React renders is counted once.
  const measured = useRef(new Map<string, number>());
  const pendingShift = useRef(0);
  // During a drag dnd-kit's autoscroll owns the scroll: a compensation under it
  // stalled the autoscroll and carried the column back up (measured in the
  // virtual-drag e2e, green without it).
  const dragging = useRef(false);
  useLayoutEffect(() => { dragging.current = activeId != null; }, [activeId]);
  const measure = useCallback((id: string, height: number, top: number) => {
    const known = measured.current.get(id) ?? VIRTUAL_ROW_ESTIMATE;
    if (Math.abs(known - height) < 1) return;
    measured.current.set(id, height);
    // A card that starts above the screen and changes height moves every card
    // fully on the screen by as much, so the scroll moves with it and what is
    // being read stays put. WebKit has no `overflow-anchor` to do it for us.
    const scroller = list.current && scrollParentOf(list.current);
    if (!dragging.current && scroller && top < scroller.getBoundingClientRect().top + scroller.clientTop) {
      pendingShift.current += height - known;
    }
    setHeights((current) => new Map(current).set(id, height));
  }, []);
  useLayoutEffect(() => {
    const shift = pendingShift.current;
    const scroller = list.current && scrollParentOf(list.current);
    if (!shift || !scroller) return;
    pendingShift.current = 0;
    scroller.scrollBy({ top: shift, behavior: 'instant' });
  }, [heights]);

  const { rows, totalHeight } = layoutVirtualRows(tasks, heights, VIRTUAL_ROW_ESTIMATE, VIRTUAL_ROW_GAP);
  const visibleIds = tasks.length <= VIRTUAL_FULL_RENDER_LIMIT
    ? new Set(rows.map((row) => row.item.id))
    : visibleVirtualIds(rows, viewport.top, Math.max(viewport.height, VIRTUAL_ROW_ESTIMATE), VIRTUAL_BUFFER, activeId);

  return (
    <div ref={list} data-board-virtual-list style={{ position: 'relative', height: totalHeight }}>
      {rows.map((row) => visibleIds.has(row.item.id) ? (
        <VirtualCardRow key={row.item.id} row={row} measure={measure}>
          {renderCard(row.item)}
        </VirtualCardRow>
      ) : (
        <SortablePlaceholder key={row.item.id} row={row} />
      ))}
    </div>
  );
}

function VirtualCardRow({ row, measure, children }: { row: RenderRow; measure: (id: string, height: number, top: number) => void; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const report = () => {
      const rect = node.getBoundingClientRect();
      measure(row.item.id, rect.height, rect.top);
    };
    const observer = new ResizeObserver(report);
    observer.observe(node);
    report();
    return () => observer.disconnect();
  }, [measure, row.item.id]);
  return <div ref={element} style={{ position: 'absolute', top: row.top, left: 0, right: 0 }}>{children}</div>;
}

function SortablePlaceholder({ row }: { row: RenderRow }) {
  const { setNodeRef, transform, transition } = useSortable({ id: row.item.id });
  const translated = transform
    ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
    : undefined;
  return (
    <div
      ref={setNodeRef}
      data-sortable-placeholder
      aria-hidden="true"
      style={{ position: 'absolute', top: row.top, left: 0, right: 0, height: row.height, transform: translated, transition, pointerEvents: 'none' }}
    />
  );
}

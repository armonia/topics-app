import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import type { BoardTask } from '../../lib/board';
import { layoutVirtualRows, visibleVirtualIds, type VirtualRow } from '../../lib/boardVirtualWindow';

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
  const measure = useCallback((id: string, height: number) => {
    setHeights((current) => {
      if (Math.abs((current.get(id) ?? VIRTUAL_ROW_ESTIMATE) - height) < 1) return current;
      const next = new Map(current);
      next.set(id, height);
      return next;
    });
  }, []);

  const { rows, totalHeight } = layoutVirtualRows(tasks, heights, VIRTUAL_ROW_ESTIMATE, VIRTUAL_ROW_GAP);
  const visibleIds = tasks.length <= VIRTUAL_FULL_RENDER_LIMIT
    ? new Set(rows.map((row) => row.item.id))
    : visibleVirtualIds(rows, viewport.top, Math.max(viewport.height, VIRTUAL_ROW_ESTIMATE), VIRTUAL_BUFFER, activeId);

  return (
    <div data-board-virtual-list style={{ position: 'relative', height: totalHeight }}>
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

function VirtualCardRow({ row, measure, children }: { row: RenderRow; measure: (id: string, height: number) => void; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const observer = new ResizeObserver(() => measure(row.item.id, node.getBoundingClientRect().height));
    observer.observe(node);
    measure(row.item.id, node.getBoundingClientRect().height);
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

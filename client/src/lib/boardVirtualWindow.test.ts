/** @covers KANBAN-01 */
import { describe, expect, test } from 'bun:test';
import { layoutVirtualRows, visibleVirtualIds } from './boardVirtualWindow';

const items = Array.from({ length: 6 }, (_, index) => ({ id: `task-${index}` }));

describe('board virtual window', () => {
  test('lays out variable measured heights with a stable gap', () => {
    const layout = layoutVirtualRows(items.slice(0, 3), new Map([['task-0', 100], ['task-1', 140]]), 80, 8);
    expect(layout.rows.map(({ top, height }) => [top, height])).toEqual([[0, 100], [108, 140], [256, 80]]);
    expect(layout.totalHeight).toBe(336);
  });

  test('mounts only rows near the viewport and pins the active drag source', () => {
    const { rows } = layoutVirtualRows(items, new Map(), 100, 8);
    const visible = visibleVirtualIds(rows, 216, 100, 0, 'task-0');
    expect([...visible]).toEqual(['task-2', 'task-0']);
  });

  test('keeps an empty column empty', () => {
    const layout = layoutVirtualRows([], new Map(), 100, 8);
    expect(layout.totalHeight).toBe(0);
    expect(visibleVirtualIds(layout.rows, 0, 100, 20)).toEqual(new Set());
  });
});

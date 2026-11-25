/**
 * The table view's sort: the header click cycle and the order of the rows.
 *
 * @covers KANBAN-120
 */
import { describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../lib/board';
import { WORKFLOW_COLUMNS } from '../../../../shared/workflow';
import { DEFAULT_TABLE_SORT, nextTableSort, sortTableTasks, tableLayout, type TableSortContext } from './boardTableModel';

const task = (id: string, over: Partial<BoardTask>): BoardTask => ({
  id, projectId: 'p1', text: id, status: 'todo', priority: 2, updatedAt: '2026-11-24T10:00:00Z', createdBy: null, assignedTo: null,
  ...over,
} as unknown as BoardTask);

const ctx: TableSortContext = {
  columns: WORKFLOW_COLUMNS,
  projectName: (id) => ({ p1: 'Zeta', p2: 'Alfa' })[id] ?? id,
  personName: null,
};
const ids = (ts: BoardTask[]) => ts.map((t) => t.id);

describe('sortTableTasks', () => {
  test('default: status follows the workflow columns, then priority high first, then newest first', () => {
    const rows = [
      task('done', { status: 'done' }),
      task('todo-low', { status: 'todo', priority: 1 }),
      task('review', { status: 'review' }),
      task('todo-high-old', { status: 'todo', priority: 4, updatedAt: '2026-11-20T10:00:00Z' }),
      task('todo-high-new', { status: 'todo', priority: 4, updatedAt: '2026-11-23T10:00:00Z' }),
      task('progress', { status: 'in_progress' }),
    ];
    expect(ids(sortTableTasks(rows, DEFAULT_TABLE_SORT, ctx))).toEqual([
      'todo-high-new', 'todo-high-old', 'todo-low', 'progress', 'review', 'done',
    ]);
  });

  test('descending status reverses the columns but keeps priority high first inside one', () => {
    const rows = [task('a', { status: 'todo', priority: 1 }), task('b', { status: 'todo', priority: 3 }), task('c', { status: 'review' })];
    expect(ids(sortTableTasks(rows, { key: 'status', dir: 'desc' }, ctx))).toEqual(['c', 'b', 'a']);
  });

  test('priority sorts urgent first, ties by status order', () => {
    const rows = [task('a', { priority: 1 }), task('b', { priority: 4, status: 'review' }), task('c', { priority: 4, status: 'todo' })];
    expect(ids(sortTableTasks(rows, nextTableSort(DEFAULT_TABLE_SORT, 'priority'), ctx))).toEqual(['c', 'b', 'a']);
  });

  test('updated sorts newest first on the first click', () => {
    const rows = [task('old', { updatedAt: '2026-11-01T00:00:00Z' }), task('new', { updatedAt: '2026-11-24T00:00:00Z' })];
    expect(ids(sortTableTasks(rows, nextTableSort(DEFAULT_TABLE_SORT, 'updated'), ctx))).toEqual(['new', 'old']);
  });

  test('title and project sort A to Z, case and accents aside', () => {
    const rows = [task('t1', { text: 'beta', projectId: 'p1' }), task('t2', { text: 'Alpha', projectId: 'p2' })];
    expect(ids(sortTableTasks(rows, { key: 'title', dir: 'asc' }, ctx))).toEqual(['t2', 't1']);
    expect(ids(sortTableTasks(rows, { key: 'project', dir: 'asc' }, ctx))).toEqual(['t2', 't1']);
  });

  test('a card in a named stage sorts by its workflow column, not by its bare status', () => {
    const ci = WORKFLOW_COLUMNS.find((c) => c.explicitOnly);
    if (!ci) return;
    const cols = WORKFLOW_COLUMNS;
    const rows = [task('plain', { status: ci.base }), task('staged', { status: ci.base, stage: ci.id })];
    const at = (id: string) => ids(sortTableTasks(rows, DEFAULT_TABLE_SORT, { ...ctx, columns: cols })).indexOf(id);
    expect(cols.findIndex((c) => c.id === ci.id) > cols.findIndex((c) => c.id === ci.base)).toBe(at('staged') > at('plain'));
  });

  test('does not mutate its input and is stable on equal rows', () => {
    const rows = [task('b', {}), task('a', {})];
    const copy = [...rows];
    expect(ids(sortTableTasks(rows, DEFAULT_TABLE_SORT, ctx))).toEqual(['a', 'b']);
    expect(rows).toEqual(copy);
  });
});

describe('nextTableSort', () => {
  test('another column starts at its natural direction, the same column flips', () => {
    expect(nextTableSort(DEFAULT_TABLE_SORT, 'priority')).toEqual({ key: 'priority', dir: 'desc' });
    expect(nextTableSort({ key: 'priority', dir: 'desc' }, 'priority')).toEqual({ key: 'priority', dir: 'asc' });
    expect(nextTableSort({ key: 'priority', dir: 'asc' }, 'title')).toEqual({ key: 'title', dir: 'asc' });
  });
});

describe('tableLayout', () => {
  test('one more column on the global board (the project, at every width), and the extras share one breakpoint', () => {
    const count = (grid: string, wide: boolean) => grid.split(wide ? ':grid-cols-[' : 'grid-cols-[')[1]!.split(']')[0]!.split('_').length;
    for (const wide of [false, true]) expect(count(tableLayout(true).grid, wide)).toBe(count(tableLayout(false).grid, wide) + 1);
    expect(tableLayout(true).extra).toContain('@3xl:');
    expect(tableLayout(false).extra).toContain('@2xl:');
  });
});

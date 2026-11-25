/**
 * The board's TABLE view: which columns a row has, how a click on a header
 * sorts, and the grid template that keeps the rows of every group aligned.
 * Pure, so the order is tested without a DOM (boardTableModel.test.ts).
 */
import type { BoardTask } from '../../lib/board';
import { columnOfTask, type WorkflowColumn } from '../../../../shared/workflow';
import { cardOwner, compareOwnerKeys } from './cardOrigin';

export const TABLE_SORT_KEYS = ['status', 'title', 'project', 'owner', 'priority', 'updated'] as const;
export type TableSortKey = (typeof TABLE_SORT_KEYS)[number];
export type TableSortDir = 'asc' | 'desc';
export interface TableSort { key: TableSortKey; dir: TableSortDir }

/** What a first click on a header means: the natural order of that column. */
export const DEFAULT_TABLE_SORT: TableSort = { key: 'status', dir: 'asc' };

/** Priority and age read best biggest/newest first; the text columns read A to Z. */
const FIRST_DIR: Record<TableSortKey, TableSortDir> = {
  status: 'asc', title: 'asc', project: 'asc', owner: 'asc', priority: 'desc', updated: 'desc',
};

/** The sort after a click on a header: the same column flips, another one starts at its natural direction. */
export function nextTableSort(current: TableSort, key: TableSortKey): TableSort {
  if (current.key !== key) return { key, dir: FIRST_DIR[key] };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

export interface TableSortContext {
  /** The workflow columns in board order: the status order follows them. */
  columns: readonly Pick<WorkflowColumn, 'id' | 'base'>[];
  projectName: (projectId: string) => string;
  personName: string | null;
}

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const timeOf = (iso: string): number => Date.parse(iso) || 0;

/** The column a task sits in, as its index in the board order (unknown columns last). */
function columnIndex(columns: TableSortContext['columns'], task: BoardTask): number {
  const col = columnOfTask(columns as WorkflowColumn[], task);
  const at = col ? columns.findIndex((c) => c.id === col.id) : -1;
  return at === -1 ? columns.length : at;
}

/**
 * The rows in the order of a header click. Ties fall through the same chain on
 * every key (status order, then priority high to low, then newest first), so
 * the order never depends on the order the tasks arrived in. Returns a copy.
 */
export function sortTableTasks(tasks: readonly BoardTask[], sort: TableSort, ctx: TableSortContext): BoardTask[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const primary = (a: BoardTask, b: BoardTask): number => {
    switch (sort.key) {
      case 'status': return columnIndex(ctx.columns, a) - columnIndex(ctx.columns, b);
      case 'title': return byText(a.text, b.text);
      case 'project': return byText(ctx.projectName(a.projectId), ctx.projectName(b.projectId));
      case 'owner': return compareOwnerKeys(cardOwner(a, ctx.personName).key, cardOwner(b, ctx.personName).key);
      case 'priority': return a.priority - b.priority;
      case 'updated': return timeOf(a.updatedAt) - timeOf(b.updatedAt);
    }
  };
  return [...tasks].sort((a, b) =>
    sign * primary(a, b)
    || columnIndex(ctx.columns, a) - columnIndex(ctx.columns, b)
    || b.priority - a.priority
    || timeOf(b.updatedAt) - timeOf(a.updatedAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The classes that make the rows line up across groups and drop the extra columns on a narrow pane. */
export interface TableLayout {
  /** The grid template, on the header and on every row. */
  grid: string;
  /** Added to a cell that only shows once the pane is wide enough (everything but status, title and age). */
  extra: string;
}

/**
 * Below the pane width where the extra columns fit only status, title and age
 * stay, so the page never scrolls sideways. The pane's width counts, not the
 * window's: an open drawer narrows the table too. The global board has one more
 * column (the project) and so needs a wider pane.
 *
 * The age column is 6rem on purpose: its header, «Aggiornato» in Italian (the (allow-italian: quotes the UI label)
 * longest of the two languages), is 57px wide at this size, and with the sort
 * arrow and the button's padding it wants ~89px. At 3.5rem and 4rem it read
 * «Aggior…» (`board-table-view.spec.ts` measures every label against its box).
 */
export function tableLayout(showProject: boolean): TableLayout {
  return showProject
    ? { grid: 'grid-cols-[6.5rem_minmax(0,1fr)_6rem] @3xl:grid-cols-[7rem_minmax(0,1fr)_8rem_7rem_5rem_6rem_4.5rem]', extra: 'hidden @3xl:flex' }
    : { grid: 'grid-cols-[6.5rem_minmax(0,1fr)_6rem] @2xl:grid-cols-[7rem_minmax(0,1fr)_7rem_5rem_6rem_4.5rem]', extra: 'hidden @2xl:flex' };
}

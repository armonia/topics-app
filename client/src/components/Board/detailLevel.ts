import { readStoredForBoard } from './boardGeometry';

/**
 * The board's VIEWS, in the order the selector shows them: the kanban (`grid`,
 * a column per status), the list, the table (a dense row per card), the cards grouped by whose work they are
 * (`plan`, no status columns) and the workflow behind the columns. The stored
 * key predates the selector, so 'list' and 'grid' still read back.
 */
export const DETAIL_LEVELS = ['grid', 'list', 'table', 'plan', 'workflow'] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** Where the preference is kept (per board, see `boardStorageKey`). */
export const DETAIL_STORAGE_KEY = 'topics.board.layout';

export function parseDetailLevel(raw: string | null): DetailLevel {
  return raw === 'list' || raw === 'table' || raw === 'plan' || raw === 'workflow' ? raw : 'grid';
}

export function readDetailLevel(boardId = 'all'): DetailLevel {
  return parseDetailLevel(readStoredForBoard(DETAIL_STORAGE_KEY, boardId));
}

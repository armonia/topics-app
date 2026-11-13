import { readStoredForBoard } from './boardGeometry';

/**
 * The board's VIEWS, in the order the selector shows them: the kanban (`grid`,
 * a column per status), the list, and the cards (`plan`: grouped cards, no
 * status columns). One selector, three entries; the stored key predates it, so
 * 'list' and 'grid' still read back.
 */
export const DETAIL_LEVELS = ['grid', 'list', 'plan'] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** Where the preference is kept (per board, see `boardStorageKey`). */
export const DETAIL_STORAGE_KEY = 'topics.board.layout';

export function parseDetailLevel(raw: string | null): DetailLevel {
  return raw === 'list' || raw === 'plan' ? raw : 'grid';
}

export function readDetailLevel(boardId = 'all'): DetailLevel {
  return parseDetailLevel(readStoredForBoard(DETAIL_STORAGE_KEY, boardId));
}

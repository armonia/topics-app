/**
 * The board's GEOMETRY, shared by the real columns and by the skeleton that
 * stands in for them while the board chunk and its first read are on the way.
 *
 * It lives in its own light module on purpose: the skeleton is rendered by
 * `LazyPane` in the main bundle, BEFORE the board chunk exists, so it cannot
 * import `Card.tsx` without pulling the whole board into the first load. And
 * the numbers cannot be copied either: a skeleton column 4 px narrower than the
 * real one is not a skeleton, it is a layout shift scheduled for later. One
 * source, two readers.
 */

/** Where the board's grid/list preference is kept (a per-viewer choice). */
export const BOARD_LAYOUT_STORAGE_KEY = 'topics.board.layout';

export type BoardLayout = 'grid' | 'list';

/** The stored preference, defaulting to the kanban grid. */
export function readBoardLayout(): BoardLayout {
  try { return localStorage.getItem(BOARD_LAYOUT_STORAGE_KEY) === 'list' ? 'list' : 'grid'; }
  catch { return 'grid'; }
}

/**
 * A column's width, as a RANGE (see the long note above `widthCls` in
 * `Card.tsx` for why each number is what it is): `basis` is the floor, `grow`
 * spends leftover room, `max-w` is the reading ceiling. Review is roomier, and
 * roomier still when it holds work. Below `sm` every column is one whole
 * slide (`basis-full`), the phone's one-column-at-a-time board of the
 * approved mockup (hub-smistamento, board.html): a peek of the neighbours
 * left a working column floating between two cut-off edges.
 */
export const COLUMN_WIDTH = {
  list: 'mx-auto w-full max-w-3xl',
  working: 'min-w-0 grow basis-full sm:basis-72 max-w-[26rem]',
  reviewWithWork: 'min-w-0 grow basis-full sm:basis-[24rem] max-w-[36rem] lg:basis-[35rem] lg:max-w-[44rem]',
  review: 'min-w-0 grow basis-full sm:basis-[22rem] max-w-[34rem] lg:basis-[32rem] lg:max-w-[44rem]',
} as const;

export function columnWidthClass(layout: BoardLayout, isReview: boolean, reviewHasWork: boolean): string {
  if (layout === 'list') return COLUMN_WIDTH.list;
  if (reviewHasWork) return COLUMN_WIDTH.reviewWithWork;
  return isReview ? COLUMN_WIDTH.review : COLUMN_WIDTH.working;
}

/** The column frame, minus the width: the same box in the board and in the skeleton. */
export const COLUMN_FRAME = 'flex flex-col rounded-lg border border-app-border bg-white/5';

/** The columns row in the kanban grid (snap classes are added by the board). */
export const COLUMNS_ROW_GRID = 'flex h-full min-w-0 gap-2 overflow-x-auto px-2 py-3 sm:gap-3 sm:px-3';

/** The columns stack in the list view. */
export const COLUMNS_ROW_LIST = 'scroll-under-chrome flex h-full min-w-0 flex-col gap-2 overflow-y-auto px-2 pt-3 pb-36 scrollbar-standard sm:px-3';

/** Where the board's grouping preference is kept: one flat board, or one lane per project. */
export const BOARD_GROUP_BY_STORAGE_KEY = 'topics.board.groupBy';
/** Whether the reader asked to see the Done column; hidden unless this says 'true'. */
export const BOARD_SHOW_DONE_STORAGE_KEY = 'topics.board.showDone';
/** The projects whose lane (and Plan tile) the reader folded, as a JSON array of project ids. */
export const BOARD_COLLAPSED_PROJECTS_STORAGE_KEY = 'topics.board.collapsedProjects';

export type BoardGroupBy = 'none' | 'project';
export type BoardDensity = 'full' | 'compact';

/** The stored grouping, defaulting to the flat board. */
export function readBoardGroupBy(): BoardGroupBy {
  try { return localStorage.getItem(BOARD_GROUP_BY_STORAGE_KEY) === 'project' ? 'project' : 'none'; }
  catch { return 'none'; }
}

/** The stored Done choice, defaulting to hidden. */
export function readBoardShowDone(): boolean {
  try { return localStorage.getItem(BOARD_SHOW_DONE_STORAGE_KEY) === 'true'; }
  catch { return false; }
}

/** Saves one view preference; private mode or a full quota only loses the memory, never the view. */
export function writeBoardPreference(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* best effort */ }
}

/** The folded projects. Anything that is not an array of strings reads as «none folded». */
export function readCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(BOARD_COLLAPSED_PROJECTS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch { return new Set(); }
}

export function writeCollapsedProjects(ids: ReadonlySet<string>): void {
  writeBoardPreference(BOARD_COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify([...ids].sort()));
}

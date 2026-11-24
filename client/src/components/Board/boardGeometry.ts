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
export const COLUMN_FRAME = 'flex flex-col rounded-lg border border-app-border bg-black/5 dark:bg-white/5';

/** The frame of a column with no cards: the same box (border width included, so nothing shifts), no line and no fill. */
export const COLUMN_FRAME_BARE = 'flex flex-col rounded-lg border border-transparent';

/**
 * The room a sideways-scrolling row of columns keeps, in ONE place for the
 * board's row and the rows inside the project lanes.
 *
 *  - `px-*`: the room at each end, the same as the page's own side padding, so
 *    the first column lines up with the headers above it. `scroll-px-*` repeats
 *    it as scroll padding: a column brought into view by `scrollIntoView` stops
 *    that far from the edge instead of flush against it.
 *  - `pb-4`: the band the overlay scrollbar owns. macOS draws the horizontal
 *    scrollbar over the BOTTOM of the scroller's padding box and takes no layout
 *    space (`offsetHeight - clientHeight` is 0), and it widens under the pointer;
 *    the columns end above that band, so the scrollbar never paints over a card.
 *    A lane row used to carry 4px, the board's row 12px: both too little.
 *  - `scroll-edge-fade`: while content is hidden past an edge, that edge fades
 *    out (static, no transition) instead of slicing a column against the window.
 *    The attributes it reads come from `trackScrollEdges`; `--edge-room` is the
 *    width it fades, the same as the padding it sits on.
 *
 * Why the end room is padding and not a spacer: padding-end is part of the
 * scrollable area of a flex scroller on the engines measured
 * (tests/e2e/board-columns-scroll-edges.spec.ts, KANBAN-122).
 */
const COLUMNS_ROW_ROOM = 'scroll-edge-fade px-2 pb-4 scroll-px-2 [--edge-room:0.5rem] sm:px-3 sm:scroll-px-3 sm:[--edge-room:0.75rem]';

/** The columns row in the kanban grid (snap classes are added by the board). */
export const COLUMNS_ROW_GRID = `flex h-full min-w-0 gap-2 overflow-x-auto pt-3 sm:gap-3 ${COLUMNS_ROW_ROOM}`;

/**
 * The columns row inside a project lane. It reaches the page edge (the negative
 * margin undoes the list's side padding) so the columns scroll under the same
 * window edge as the board's row, and its own padding gives the first column the
 * lane header's left edge back.
 */
export const COLUMNS_LANE_ROW = `flex min-w-0 gap-2 overflow-x-auto -mx-2 sm:-mx-3 sm:gap-3 ${COLUMNS_ROW_ROOM}`;

/** The columns stack in the list view. */
export const COLUMNS_ROW_LIST = 'scroll-under-chrome flex h-full min-w-0 flex-col gap-2 overflow-y-auto px-2 pt-3 pb-36 scrollbar-standard sm:px-3';

/** Where the board's grouping preference is kept: one flat board, or one lane per project. */
export const BOARD_GROUP_BY_STORAGE_KEY = 'topics.board.groupBy';
/** Whether the reader asked to see the Done column; hidden unless this says 'true'. */
export const BOARD_SHOW_DONE_STORAGE_KEY = 'topics.board.showDone';
/** The projects whose lane (and Plan tile) the reader folded, as a JSON array of project ids. */
export const BOARD_COLLAPSED_PROJECTS_STORAGE_KEY = 'topics.board.collapsedProjects';

/** What cards can be grouped by. `none` = flat. */
export const GROUP_KEYS = ['none', 'project', 'status', 'assignee', 'owner', 'priority'] as const;
export type BoardGroupBy = (typeof GROUP_KEYS)[number];
/** Where the second grouping level («then by») is kept. */
export const BOARD_THEN_BY_STORAGE_KEY = 'topics.board.thenBy';

export function parseGroupKey(raw: string | null | undefined): BoardGroupBy {
  // `closer` was the grouping before `owner` replaced it: a stored choice keeps working.
  if (raw === 'closer') return 'owner';
  return (GROUP_KEYS as readonly string[]).includes(raw ?? '') ? (raw as BoardGroupBy) : 'none';
}

/**
 * A view preference is kept PER BOARD (`<key>:<boardId>`); a board that never
 * chose reads the old board-less key, so nobody loses the choice made before.
 */
export function boardStorageKey(key: string, boardId: string): string {
  return `${key}:${boardId}`;
}

export function readStoredForBoard(key: string, boardId: string): string | null {
  try { return localStorage.getItem(boardStorageKey(key, boardId)) ?? localStorage.getItem(key); }
  catch { return null; }
}
/** How much of each card is drawn, from the least to the most: the slider's stops. */
export const BOARD_DENSITIES = ['title', 'compact', 'full'] as const;
export type BoardDensity = (typeof BOARD_DENSITIES)[number];
/** Where the reader's density is kept, per board; nothing stored = the view's default. */
export const BOARD_DENSITY_STORAGE_KEY = 'topics.board.density';
/** Where the «columns» choice (separate or one merged column) is kept, per board; see `columnsMode.ts`. */
export const BOARD_COLUMNS_STORAGE_KEY = 'topics.board.columns';

export function parseBoardDensity(raw: string | null | undefined): BoardDensity | null {
  return (BOARD_DENSITIES as readonly string[]).includes(raw ?? '') ? (raw as BoardDensity) : null;
}

/** The stored grouping, defaulting to the flat board. */
export function readBoardGroupBy(boardId = 'all'): BoardGroupBy {
  return parseGroupKey(readStoredForBoard(BOARD_GROUP_BY_STORAGE_KEY, boardId));
}

/** The stored second level, defaulting to none. */
export function readBoardThenBy(boardId = 'all'): BoardGroupBy {
  return parseGroupKey(readStoredForBoard(BOARD_THEN_BY_STORAGE_KEY, boardId));
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

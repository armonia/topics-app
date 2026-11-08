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

/** Where the board's grouping is kept: one row of columns per project, or none (a per-viewer choice). */
export const BOARD_GROUP_STORAGE_KEY = 'topics.board.groupBy';

export type BoardGroupBy = 'none' | 'project';

export function readBoardGroupBy(): BoardGroupBy {
  try { return localStorage.getItem(BOARD_GROUP_STORAGE_KEY) === 'project' ? 'project' : 'none'; }
  catch { return 'none'; }
}

/** Where the cards' density is kept: the whole card, or its compact face (a per-viewer choice). */
export const BOARD_DENSITY_STORAGE_KEY = 'topics.board.density';

/**
 * `compact` keeps what a card is at a glance: the project, the title with its
 * status and priority, the relational chips, the foot (model, machine, cost,
 * changes, last update), the live tool and why it is parked. It drops what is
 * read once the card is open: the preview image, the checklist, the
 * description, the review exchange and the progress note.
 */
export type CardDensity = 'full' | 'compact';

export function readCardDensity(): CardDensity {
  try { return localStorage.getItem(BOARD_DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'full'; }
  catch { return 'full'; }
}

/** The project rows (swimlanes): the vertical stack that holds them, and one row of columns. */
export const LANES_STACK = 'scroll-under-chrome flex h-full min-w-0 flex-col gap-3 overflow-auto px-2 pt-3 pb-36 scrollbar-standard sm:px-3';
export const LANE_ROW_GRID = 'flex min-w-0 items-start gap-2 sm:gap-3';
export const LANE_ROW_LIST = 'flex min-w-0 flex-col gap-2';

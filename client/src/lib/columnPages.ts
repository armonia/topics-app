import { COLUMN_PAGE } from './boardOrder';

/**
 * How many cards of a paged column (Review, Done) the reader has already
 * brought in, remembered for the life of the page.
 *
 * The count lives in the column's own state, and a view change (the archive
 * toggle, a board that goes back to its skeleton for a fresh read) unmounts
 * the columns: the reader who had scrolled Done to 50 found 25 again and had
 * to scroll through the same cards a second time. Remembering what was
 * REACHED, per board view and column, hands the same pages back at the next
 * mount. It loads nothing the reader did not reach, and it is not persisted:
 * a reload starts from the first page.
 */
const reached = new Map<string, number>();

const slot = (view: string, status: string): string => `${view}|${status}`;

/** The pages already reached in this view and column; the first page if none. */
export function recallColumnPages(view: string, status: string): number {
  return reached.get(slot(view, status)) ?? COLUMN_PAGE;
}

/** Notes how many cards the column draws now. A count under one page forgets the slot. */
export function rememberColumnPages(view: string, status: string, shown: number): void {
  if (shown <= COLUMN_PAGE) reached.delete(slot(view, status));
  else reached.set(slot(view, status), shown);
}

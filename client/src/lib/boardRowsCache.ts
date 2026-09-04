/**
 * THE ROWS OF THE LAST BOARD YOU LOOKED AT, kept locally.
 *
 * A reload used to land on empty columns for as long as the feed took to
 * answer: measured on this machine, the kanban had nothing in it for 380 ms at
 * 390px and 510 ms at 1440px after `DOMContentLoaded`, then filled in one go.
 * The CLS was a clean zero - nothing MOVED, because there was nothing there -
 * which is exactly why a second number is measured next to it: a surface that
 * draws late is a surface the reader watches boot.
 *
 * The copy is a SEED, not an authority: the fetch leaves at the same moment and
 * overwrites it as soon as it answers, so a task moved from another window does
 * not stick. What the seed buys is the FIRST FRAME, drawn with the geometry the
 * reader left behind.
 *
 * The cap is per query, and it is about the viewport, not the truth: 200 rows
 * are more cards than any column can show, and the whole cross-project feed is
 * 1.4 MB - past the point where writing it back on every read costs more than
 * the flash it removes.
 */
import type { BoardTask } from './board';

const PREFIX = 'board-rows-cache:';
const MAX_ROWS = 200;

/** The identity of a query, so two boards never read each other's rows. */
export function boardRowsCacheKey(scope: string): string {
  return PREFIX + scope;
}

export function readBoardRowsCache(scope: string): readonly BoardTask[] | null {
  try {
    const raw = localStorage.getItem(boardRowsCacheKey(scope));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // A cache written by an older shape must not enter the store: one field
    // check is enough to tell rows from whatever else ended up under the key.
    const rows = parsed.filter(
      (r): r is BoardTask =>
        !!r && typeof r === 'object' && typeof (r as BoardTask).id === 'string' && typeof (r as BoardTask).status === 'string',
    );
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

export function writeBoardRowsCache(scope: string, rows: readonly BoardTask[]): void {
  try {
    localStorage.setItem(boardRowsCacheKey(scope), JSON.stringify(rows.slice(0, MAX_ROWS)));
  } catch {
    /* quota, private mode: the seed is an optimisation, never a requirement */
  }
}

/**
 * Which edges of a sideways-scrolling row still have content past them.
 *
 * Written straight on the row as `data-edge-start` / `data-edge-end`, never as
 * React state: a scroll must not render the board, and the only reader is the
 * `scroll-edge-fade` utility in index.css, which fades an edge while its
 * attribute is on. The attribute changes only where the answer changes (the
 * ends of the scroll, a column added or resized), so a drag of the scrollbar
 * costs one style recalculation of the row, not one per frame.
 */
import type { RefCallback } from 'react';

/** Sub-pixel scroll positions at rest are not «content past the edge». */
const EDGE_SLACK_PX = 1;

/** Start tracking `row`; the returned function stops it. */
export function trackScrollEdges(row: HTMLElement): () => void {
  const sync = () => {
    const max = row.scrollWidth - row.clientWidth;
    row.toggleAttribute('data-edge-start', row.scrollLeft > EDGE_SLACK_PX);
    row.toggleAttribute('data-edge-end', row.scrollLeft < max - EDGE_SLACK_PX);
  };
  // The content's width moves without the row resizing (a column that gains work widens, one folds away),
  // so the columns are watched too; they are the row's direct children, and the list of them is watched below.
  const resize = new ResizeObserver(sync);
  const watchChildren = () => {
    resize.disconnect();
    resize.observe(row);
    for (const child of Array.from(row.children)) resize.observe(child);
  };
  const children = new MutationObserver(() => { watchChildren(); sync(); });
  watchChildren();
  children.observe(row, { childList: true });
  row.addEventListener('scroll', sync, { passive: true });
  sync();
  return () => {
    row.removeEventListener('scroll', sync);
    resize.disconnect();
    children.disconnect();
  };
}

/** `trackScrollEdges` as a ref callback (it returns its own cleanup, React 19), for a row that needs no other ref. */
export const scrollEdgesRef: RefCallback<HTMLElement> = (row) => (row ? trackScrollEdges(row) : undefined);

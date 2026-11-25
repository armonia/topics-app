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
import { SOFT_EDGE_CLASS } from './boardGeometry';

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

/** How far past the window a column's previews start loading: Chromium's own lazy distance on a fast connection. */
const PRELOAD_AHEAD_PX = 1250;

/**
 * A lazy preview image keeps loading ahead of its column under a soft edge.
 *
 * Chromium lets a `loading="lazy"` image inside a scroller load a little before
 * it scrolls into view only through a margin it adds to the scroller's clip,
 * and it drops that margin when a MASK sits above the scroller. The fade is
 * exactly that: a mask on the row. Without this, a preview one column past the
 * window edge stayed a 2px box until the column was swiped in, and then the card
 * jumped to its real height (tests/e2e/board-preview-cap.spec.ts, 4 of 4 runs).
 *
 * So the image asks for itself: an observer rooted at the row, whose root is
 * widened sideways, flips the image to `eager` (which starts a load that was
 * waiting) once it is that close to the window. Only the sideways direction is
 * widened: a card further down its column keeps the browser's own lazy loading.
 * Outside a soft-edge row there is nothing to do.
 */
export const preloadBesideEdge: RefCallback<HTMLImageElement> = (img) => {
  if (!img || typeof IntersectionObserver === 'undefined') return undefined;
  const row = img.closest<HTMLElement>(`.${SOFT_EDGE_CLASS}`);
  if (!row) return undefined;
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    img.loading = 'eager';
    observer.disconnect();
  }, { root: row, rootMargin: `0px ${PRELOAD_AHEAD_PX}px` });
  observer.observe(img);
  return () => observer.disconnect();
};

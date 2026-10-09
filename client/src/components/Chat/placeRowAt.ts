import type { VirtuosoHandle } from 'react-virtuoso';

/**
 * Puts the row at `index` with its top `offset` px from the viewport's top,
 * rendered and final before the frame paints.
 *
 * Not with `scrollToIndex`. After a merge made while hidden, the sizes
 * Virtuoso keeps by index belong to other rows, so it lands on an estimate,
 * and it re-scrolls to the index once the rows are measured, a frame later:
 * the row being read moved by 72-99 px, sometimes back and forth over three
 * frames (tab-switch audit, TABSWITCH-03 reader scrolled up), and even from
 * the exact place, that re-scroll still moved it by 2 px (its offsets and the
 * DOM disagree by the rounding of the sizes). Here the same estimate is
 * computed from Virtuoso's sizes and written as a plain scroll offset, which
 * arms no re-scroll; the rows are rendered at once (the `scroll` event, see
 * `renderNow` in `pinToBottom`), the row's real place is read and the
 * difference scrolled, in the same callback.
 */
export function placeRowAt(el: HTMLElement, virtuoso: VirtuosoHandle | null, index: number, offset: number): void {
  let estimate = 0;
  virtuoso?.getState(({ ranges }) => {
    for (const range of ranges) {
      if (range.startIndex >= index) break;
      estimate += (Math.min(range.endIndex, index - 1) - range.startIndex + 1) * range.size;
    }
  });
  el.scrollTop = estimate - offset;
  el.dispatchEvent(new Event('scroll'));
  // Each correction renders a slightly different range above the row, which
  // can shift it again: measured, three corrections (-123, -36, +0.1 px) and
  // a fourth read that finds it in place.
  for (let pass = 0; pass < 4; pass++) {
    const row = el.querySelector(`[data-testid="virtuoso-item-list"] > [data-index="${index}"]`);
    if (!row) return;
    const off = row.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
    if (Math.abs(off) < 0.5) break;
    el.scrollTop += off;
    el.dispatchEvent(new Event('scroll'));
  }
  // The last step goes DOWN, by one pixel and back. Virtuoso compensates for
  // "rows above resized" only while its last scroll went up (`scrollDirection`,
  // reset after 50 ms without scrolling), and the next frame it measures the
  // rows rendered here, at sizes other than the stale ones it had: when the
  // last correction went up, it scrolled by their whole difference, rows that
  // were already in place (-471 px, 1 return in 5). Same offset, no direction.
  if (el.scrollTop >= 1) {
    el.scrollTop -= 1;
    el.dispatchEvent(new Event('scroll'));
    el.scrollTop += 1;
    el.dispatchEvent(new Event('scroll'));
  }
}

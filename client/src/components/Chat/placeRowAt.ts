import type { VirtuosoHandle } from 'react-virtuoso';

/**
 * What of a row the reader reads: its message (`data-row-body`), not its box.
 * The first row also carries the "load the earlier messages" divider, which
 * the merge takes away: a box kept still while the divider leaves moved the
 * message up by the divider's 40 px.
 */
export function rowBody(row: Element): Element {
  return row.firstElementChild?.querySelector(':scope > [data-row-body]') ?? row;
}

/**
 * Puts the body of the row at `index` (`rowBody`) with its top `offset` px
 * from the viewport's top, rendered and final before the frame paints.
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
    const off = rowBody(row).getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
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

/** How many frames after a merge the row being read is held (`rowHolder`): Virtuoso renders, measures and settles. */
export const HOLD_ROW_FRAMES = 20;

/**
 * Holds the BOTTOM of the body of a row `bottom` px from the viewport's top,
 * for `HOLD_ROW_FRAMES` frames: the merge of the rest of the history
 * (CHAT-HIST-01). `hold` starts one, `release` ends it (a reader's gesture),
 * `dispose` ends it without `onDrawn`: it runs inside React's commit.
 *
 * The bottom, because what a merge takes away is at the top of the first row
 * it had: the "load the earlier messages" divider and the date separator a
 * first message carries (it has no message before it any more). Kept by its
 * top, that row's bubble and every row under it moved up by those 40 + 28 px.
 *
 * Virtuoso's own work comes first. A prepend is drawn in two frames (an
 * estimated `deviation`, then the real range), and the prepended rows that
 * land in the overscan above the reader are measured only then: 1683 px
 * taller than estimated, measured on a list at rest. Virtuoso compensates for
 * rows measured above the viewport only while its last scroll went up, so a
 * hold opens with one pixel down and one up, which changes no offset; and it
 * measures in the same frame because the list sets
 * `skipAnimationFrameInResizeObserver`. Its compensation moves `scrollTop` but
 * draws the range there only at the next scroll event, a frame later: so a row
 * not drawn gets that scroll event now. The divider and the date separator
 * stay on that row (`onDrawn` drops them) until the real range is drawn: in
 * the `deviation` frame Virtuoso draws the old rows with the new list, and
 * without them the row read moved up 75 px there. Then what they leave is
 * scrolled away, in the same callback.
 *
 * Only in a ResizeObserver, never in an animation frame: there the new rows
 * are drawn and not yet measured, and a correction on the DOM's word moved the
 * list out of the range Virtuoso then drew. The observer is made with the
 * list and watches the scroller from then on (WebKit runs observers in the
 * order they started observing, and drops one that disconnects), so it runs
 * after Virtuoso's and before any made later. While it holds it also watches
 * the item list and a sentinel resized every frame: the item list
 * changes size only once Virtuoso has measured, which put the correction in a
 * later round of observers than the first, and the first is the one anything
 * else reading the frame before it paints gets.
 */
export function rowHolder(el: HTMLElement): { hold(indexOf: () => number, bottom: number, onDrawn: () => void): void; release(): void; dispose(): void } {
  let target: { indexOf: () => number; bottom: number; onDrawn: (() => void) | null } | null = null;
  let left = 0;
  let raf = 0;
  // Every move ends going up, for the reason a hold opens that way.
  const scrollBy = (delta: number): void => {
    el.scrollTop += delta + 1;
    el.dispatchEvent(new Event('scroll'));
    el.scrollTop -= 1;
    el.dispatchEvent(new Event('scroll'));
  };
  const rowOf = (index: number) => (index < 0 ? null : el.querySelector(`[data-testid="virtuoso-item-list"] > [data-index="${index}"]`));
  const fix = (): void => {
    if (!target || el.clientHeight === 0) return;
    const index = target.indexOf();
    let row = rowOf(index);
    if (!row && index >= 0) {
      el.dispatchEvent(new Event('scroll'));
      row = rowOf(index);
    }
    if (!row) return;
    target.onDrawn?.();
    target.onDrawn = null;
    const off = rowBody(row).getBoundingClientRect().bottom - el.getBoundingClientRect().top - target.bottom;
    if (Math.abs(off) >= 0.5) scrollBy(off);
  };
  const ro = new ResizeObserver(fix);
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none';
  ro.observe(el);
  let list: Element | null = null;
  const release = (): void => {
    target?.onDrawn?.();
    target = null;
    cancelAnimationFrame(raf);
    if (list) ro.unobserve(list);
    list = null;
    ro.unobserve(sentinel);
    sentinel.remove();
  };
  const tick = (): void => {
    sentinel.style.width = `${(left % 2) + 1}px`;
    if (--left > 0) raf = requestAnimationFrame(tick);
    else release();
  };
  return {
    hold(indexOf, bottom, onDrawn) {
      release();
      target = { indexOf, bottom, onDrawn };
      list = el.querySelector('[data-testid="virtuoso-item-list"]');
      if (list) ro.observe(list);
      document.body.appendChild(sentinel);
      ro.observe(sentinel);
      scrollBy(0);
      left = HOLD_ROW_FRAMES;
      raf = requestAnimationFrame(tick);
    },
    release,
    dispose() {
      if (target) target.onDrawn = null;
      release();
      ro.disconnect();
    },
  };
}

import { useLayoutEffect, useRef, type MutableRefObject } from 'react';

const ITEM_ROWS = '[data-testid="virtuoso-item-list"] > [data-index]';
/** Frames the list waits for Virtuoso's measure before handing it the scroll anyway. */
const MEASURE_WAIT_FRAMES = 10;
const USER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * How much taller the rendered rows are than the sizes Virtuoso keeps for them
 * (`data-known-size`): what grew while the list had no box to be measured in.
 */
function unmeasuredGrowth(scroller: HTMLElement): number {
  let grown = 0;
  for (const row of scroller.querySelectorAll<HTMLElement>(ITEM_ROWS)) {
    const known = parseFloat(row.dataset.knownSize ?? '');
    if (Number.isFinite(known)) grown += row.offsetHeight - known;
  }
  return grown;
}

type ReturnPinDeps = {
  paneAlive: boolean;
  scrollerElRef: MutableRefObject<HTMLElement | null>;
  itemsRef: MutableRefObject<readonly unknown[]>;
  restoreAnchorRef: MutableRefObject<unknown>;
  userTouchedRef: MutableRefObject<boolean>;
  pinToBottom: (opts: { now: true; force: boolean; settleFrames: 0 }) => void;
};

/**
 * The pane gets its box back in the commit of the input that selects it: if
 * the list grew while it was hidden (a turn that ran behind another tab), the
 * bottom is pinned HERE, before the first frame.
 *
 * A hidden scroller has no box, so every pin of that turn wrote to nothing and
 * the viewport comes back at the old bottom, a whole reply short. The "pane
 * returns visible" branch of the list's ResizeObserver lands it, but after the
 * frame's animation callbacks (TABSWITCH-01 "a chat whose turn ran while it was
 * hidden").
 *
 * Virtuoso could not measure the rows either, and measures them only from its
 * own ResizeObserver, a frame or two after the return. Handed the scroll to the
 * true bottom of a long reply with the old sizes, its range lies past the end
 * of the list it knows: it renders no row, the content shrinks by the reply's
 * growth, the offset is clamped to the old bottom and the reply jumps by that
 * much once measured (1230 px for 30 paragraphs). So when the rendered rows are
 * taller than Virtuoso knows, the bottom is pinned over the rows already in the
 * DOM and the scroll is kept from the list's listeners until Virtuoso has
 * measured them, then sent to them again. What is left moves by under a pixel:
 * once measured, Virtuoso trades the rows above the viewport for a padding of
 * their whole-pixel sizes (0.08-0.63 px measured).
 *
 * Only when the last row is already in the DOM: then this is a scroll over rows
 * Virtuoso rendered. Otherwise (a merge re-indexed the list, a reader's anchor
 * to put back) the observer branch keeps the case, as before.
 */
export function useHiddenTurnReturn(deps: ReturnPinDeps): void {
  const { paneAlive, scrollerElRef, itemsRef, restoreAnchorRef, userTouchedRef, pinToBottom } = deps;
  const aliveAtLastLayoutRef = useRef(paneAlive);
  useLayoutEffect(() => {
    const cameBack = paneAlive && !aliveAtLastLayoutRef.current;
    aliveAtLastLayoutRef.current = paneAlive;
    if (!cameBack) return;
    let drop: (() => void) | null = null;
    // In a microtask, still before the frame: out of React's commit, so the
    // `scroll` sent below renders Virtuoso's new range at once (its handler runs
    // in `flushSync`, which a layout effect would only defer). That render
    // changes the content height by the rounding of its sizes (+1 px measured),
    // so the bottom is read again after it.
    queueMicrotask(() => {
      if (restoreAnchorRef.current) return;
      const el = scrollerElRef.current;
      if (!el || el.clientHeight === 0) return;
      const last = itemsRef.current.length - 1;
      if (last < 0 || !el.querySelector(`[data-testid="virtuoso-item-list"] > [data-index="${last}"]`)) return;
      const force = !userTouchedRef.current;
      if (unmeasuredGrowth(el) > 1) {
        const from = el.scrollTop;
        drop = holdScrollUntilMeasured(el);
        pinToBottom({ now: true, force, settleFrames: 0 });
        // Not pinned (a reader holds the viewport): nothing to keep from anyone.
        if (el.scrollTop === from) drop();
        return;
      }
      for (let pass = 0; pass < 3; pass++) {
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= 0.5) return;
        pinToBottom({ now: true, force, settleFrames: 0 });
        el.dispatchEvent(new Event('scroll'));
      }
    });
    // Hidden again or unmounted: no scroll to send to a list without a box.
    return () => drop?.();
  }, [paneAlive, pinToBottom, scrollerElRef, itemsRef, restoreAnchorRef, userTouchedRef]);
}

/**
 * Keeps the scroller's `scroll` events from its own listeners (Virtuoso's and
 * the list's) until the rows it renders are measured, or a user's input, or
 * `MEASURE_WAIT_FRAMES`; then sends one, so each listener reads the offset it
 * missed. Returns the drop: the hold is lifted and nothing is sent.
 */
function holdScrollUntilMeasured(el: HTMLElement): () => void {
  const host = el.parentElement;
  if (!host) return () => {};
  const hold = (e: Event) => { if (e.target === el) e.stopPropagation(); };
  let frames = 0;
  let raf = 0;
  const lift = () => {
    host.removeEventListener('scroll', hold, true);
    for (const type of USER_INPUT) el.removeEventListener(type, release, true);
    cancelAnimationFrame(raf);
  };
  const release = () => { lift(); el.dispatchEvent(new Event('scroll')); };
  const tick = () => {
    if (++frames >= MEASURE_WAIT_FRAMES || unmeasuredGrowth(el) <= 1) release();
    else raf = requestAnimationFrame(tick);
  };
  host.addEventListener('scroll', hold, true);
  for (const type of USER_INPUT) el.addEventListener(type, release, true);
  raf = requestAnimationFrame(tick);
  return lift;
}

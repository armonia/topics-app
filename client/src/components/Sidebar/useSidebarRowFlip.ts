import { useLayoutEffect, useRef, type RefObject } from 'react';

import { animateEl, EASE, MOTION } from '../../lib/motion';
import { liveTranslate } from './useCellFlip';

/**
 * Sidebar rows TRAVEL to their new place instead of teleporting.
 *
 * The column changes shape all the time for reasons the user did not just
 * cause: the recency sort lifts a project over another on every send or open,
 * an accordion opens because a project tab was opened, a pinned tile takes a
 * row, an archived chat leaves. Every one of those used to land in ONE frame:
 * measured, 200-440 px jumps of whole groups (recency reorder), 123 px on an
 * accordion, 47 px when a tile appeared, 40 px when a row was archived. In
 * peripheral vision a column that jumps like that looks as if it reloaded.
 *
 * FLIP, because there is no CSS property to transition: a row's place is its
 * order in the DOM. After each commit every unit is measured (Last), compared
 * with the previous commit (First), put back where it was with a transform
 * (Invert) and animated to zero (Play). Only `transform` and `opacity` are
 * animated, with the app's motion tokens; `animateEl` does nothing under
 * prefers-reduced-motion, so there the column simply lands.
 *
 * What moves, and what appears:
 *  - a unit that MOVED slides over `MOTION.base` (a row crossing space);
 *  - a unit that is NEW fades in over `MOTION.fast`, where it already is, so
 *    the rows sliding out of its way never cross an opaque copy of it;
 *  - a unit that LEFT is gone at once, and the ones after it slide up.
 *
 * Positions are taken RELATIVE TO THE NEAREST ENCLOSING UNIT (or to the
 * scrolling column, plus its scrollTop). Two consequences, both wanted:
 * scrolling moves nothing (the column scrolls with its rows), and a row inside
 * a moving group card animates only its own movement inside the card, so the
 * card's translation and the row's never add up twice.
 *
 * The first pass after mount only records: whatever is in memory is on screen
 * in the first frame, as it was.
 *
 * The pinned tiles are left to `useCellFlip`, which already animates them
 * inside their grid; here the pinned block moves as one unit.
 */

/** What counts as one moving piece of the column. */
const UNIT_SELECTOR = [
  '[role="treeitem"]',
  '[data-testid="sidebar-pinned-section"]',
  '[data-testid="pinned-divider"]',
  '[data-testid^="space-card"]',
  '[data-sidebar-flip]',
].join(',');

const PINNED_SECTION = '[data-testid="sidebar-pinned-section"]';

/** Below this, a difference is a rounding error, not a move. */
const MIN_MOVE_PX = 1;

interface Spot {
  top: number;
}

interface FlipState {
  spots: WeakMap<Element, Spot>;
  running: WeakMap<Element, Animation>;
}

/**
 * One pass over the column: measure every unit, and when `animate` is set,
 * start the moves and fades against the previous pass. Returns the units, so
 * the caller can watch their size.
 */
function flipPass(column: HTMLElement, state: FlipState, animate: boolean): HTMLElement[] {
  const origin = column.getBoundingClientRect();
  const scrollTop = column.scrollTop;
  const units = Array.from(column.querySelectorAll<HTMLElement>(UNIT_SELECTOR)).filter((el) => {
    // Inside the pinned block the tiles belong to useCellFlip.
    const pinned = el.closest(PINNED_SECTION);
    return !pinned || pinned === el;
  });
  const unitSet = new Set<Element>(units);

  /** The unit this one lives inside, if any: its coordinate frame. */
  const frameOf = (el: HTMLElement): HTMLElement | null => {
    let p = el.parentElement;
    while (p && p !== column) {
      if (unitSet.has(p)) return p;
      p = p.parentElement;
    }
    return null;
  };
  const rects = new Map<Element, DOMRect>();
  const rectOf = (el: HTMLElement): DOMRect => {
    let r = rects.get(el);
    if (!r) { r = el.getBoundingClientRect(); rects.set(el, r); }
    return r;
  };
  // Only an element with a move in flight can carry a transform of ours;
  // everyone else is read without a style query.
  const liveY = (el: Element): number => (state.running.has(el) ? liveTranslate(el).y : 0);

  const track = (el: Element, a: Animation | null): void => {
    if (!a) { state.running.delete(el); return; }
    state.running.set(el, a);
    a.finished
      .then(() => { if (state.running.get(el) === a) state.running.delete(el); })
      // `cancel()` rejects `finished`: the normal case when a move restarts.
      .catch(() => {});
  };

  for (const el of units) {
    const r = rectOf(el);
    if (r.width === 0 && r.height === 0) continue; // not laid out (display:none)
    const frame = frameOf(el);
    // A unit's rect includes its frame's live transform, and so does the
    // frame's own rect: the difference is free of it. The unit's OWN live
    // transform is taken out explicitly. What is stored is the LAYOUT top.
    const ty = liveY(el);
    const top = frame
      ? r.top - rectOf(frame).top - ty
      : r.top - origin.top + scrollTop - ty;
    const before = state.spots.get(el);
    state.spots.set(el, { top });
    if (!animate) continue;

    if (!before) {
      // Appeared: fade in on the spot.
      state.running.get(el)?.cancel();
      track(el, animateEl(el, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fast, easing: EASE.standard }));
      continue;
    }
    // Start from where it is SEEN now: previous layout plus the part of an
    // earlier move still being applied.
    const dy = before.top - top + ty;
    if (Math.abs(dy) < MIN_MOVE_PX) continue;
    state.running.get(el)?.cancel();
    track(el, animateEl(
      el,
      [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
      { duration: MOTION.base, easing: EASE.standard },
    ));
  }
  return units;
}

export function useSidebarRowFlip(root: RefObject<HTMLElement | null>): void {
  const state = useRef<FlipState>({ spots: new WeakMap(), running: new WeakMap() });
  const measured = useRef(false);
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());

  // A row can change size WITHOUT this tree re-rendering (its own subline, a
  // badge, a relative time): the rows under it move with no commit here to
  // see it. Left alone, the next unrelated commit would compare against the
  // stale spots and slide rows that already moved long ago. A size change of
  // any unit therefore re-records the spots, without animating.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const column = root.current;
      if (column) flipPass(column, state.current, false);
    });
    observer.current = ro;
    const watched = observed.current;
    return () => { ro.disconnect(); observer.current = null; watched.clear(); };
  }, [root]);

  // No dependency array on purpose: the commit itself is the event to follow.
  useLayoutEffect(() => {
    const column = root.current;
    if (!column) return;
    // The first pass only records: what is in memory is on screen in the
    // first frame, and nothing flies in.
    const units = flipPass(column, state.current, measured.current);
    measured.current = true;
    const ro = observer.current;
    if (!ro) return;
    // An observer holds its targets: a row that left must be let go, or a
    // long session keeps every row it ever showed.
    const now = new Set<Element>(units);
    for (const el of observed.current) {
      if (!now.has(el)) { ro.unobserve(el); observed.current.delete(el); }
    }
    for (const el of units) {
      if (!observed.current.has(el)) { ro.observe(el); observed.current.add(el); }
    }
  });
}

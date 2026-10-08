import { useEffect, useRef, useState } from 'react';
import { loadOnReach, type ListState, type LoadOnReach } from '../lib/loadOnReach';

/** How far below the visible area the "show more" row starts loading: the page lands before the reader gets there. */
const AHEAD_PX = 240;

/** The element that scrolls the row: the observer's root, so the margin above counts inside it. */
function scrollParent(el: HTMLElement): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return p;
  }
  return null;
}

/**
 * Infinite scroll for a list that grows downwards: returns the ref for its
 * "show more" row, which then loads the next page by itself as it comes into
 * view (see `lib/loadOnReach.ts` for when). The row stays a button, so the
 * keyboard and a browser without IntersectionObserver keep the click.
 */
export function useLoadOnReach(load: () => void, state: ListState): (el: HTMLElement | null) => void {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const latest = useRef({ load, state });
  useEffect(() => {
    latest.current = { load, state };
  });
  const ctl = useRef<LoadOnReach | null>(null);
  // One controller and one observer per row element, settled at once with the list as it is.
  useEffect(() => {
    if (!row || typeof IntersectionObserver === 'undefined') return;
    // A target observed anew always gets a first answer: that is the fresh look a landed page asks for.
    const remeasure = (): void => {
      io.unobserve(row);
      io.observe(row);
    };
    const controller = loadOnReach(() => latest.current.load(), remeasure);
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) controller.seen(entry.isIntersecting);
    }, { root: scrollParent(row), rootMargin: `0px 0px ${AHEAD_PX}px 0px` });
    io.observe(row);
    ctl.current = controller;
    controller.settle(latest.current.state);
    return () => {
      io.disconnect();
      ctl.current = null;
    };
  }, [row]);
  const { more, loading, count, enabled } = state;
  useEffect(() => {
    ctl.current?.settle({ more, loading, count, enabled });
  }, [more, loading, count, enabled]);
  return setRow;
}

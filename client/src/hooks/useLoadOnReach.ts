import { useEffect, useRef, useState } from 'react';
import { loadOnReach, type ListState, type LoadOnReach } from '../lib/loadOnReach';

/** How far below the visible area the "show more" row starts loading: the page lands before the reader gets there. */
const AHEAD_PX = 240;

/** The element that scrolls the row now: the observer's root, so the margin above counts inside it. */
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
 *
 * `layout` names how the list is laid out, for a list that can switch (a board
 * column, grid or list): a switch hands the row to another scroller without a
 * word from the observers, so the hook looks again.
 */
export function useLoadOnReach(load: () => void, state: ListState, layout?: string): (el: HTMLElement | null) => void {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const latest = useRef({ load, state });
  useEffect(() => {
    latest.current = { load, state };
  });
  const controllerRef = useRef<LoadOnReach | null>(null);
  const watchRef = useRef<(() => void) | null>(null);
  // One controller per row element, settled at once with the list as it is.
  useEffect(() => {
    if (!row || typeof IntersectionObserver === 'undefined') return;
    let io: IntersectionObserver | null = null;
    let onScreen: IntersectionObserver | null = null;
    // A new observer always gives a first answer: that is the fresh look a moved list asks for. It is
    // rebuilt on the element that scrolls the row NOW: a layout switch (a board column turned list) takes
    // the scroll away from the old root, which then holds the row in view forever and pages chain.
    // The root clips only its own content: a column scrolled out of the board still sees its row, so the
    // root itself must be on screen too (a second observer, on the viewport, which every clip counts in).
    // Every answer of either one checks the root first: the switch moves the scroll and not the row, so the
    // old root may never speak again, and the old column coming on screen would load from far above the row.
    // That covers a switch the old observers see. Back from list to grid they see nothing (the row, far down,
    // stays out of view), so the switch itself calls `watch` too (the `layout` effect below).
    const watch = (): void => {
      io?.disconnect();
      onScreen?.disconnect();
      const root = scrollParent(row);
      let near = false;
      let shown = !root;
      const tell = (): void => {
        if (scrollParent(row) !== root) watch();
        else controller.seen(near && shown);
      };
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) near = entry.isIntersecting;
        tell();
      }, { root, rootMargin: `0px 0px ${AHEAD_PX}px 0px` });
      io.observe(row);
      if (!root) return;
      onScreen = new IntersectionObserver((entries) => {
        for (const entry of entries) shown = entry.isIntersecting;
        tell();
      });
      onScreen.observe(root);
    };
    const controller = loadOnReach(() => latest.current.load(), watch);
    watch();
    controllerRef.current = controller;
    watchRef.current = watch;
    controller.settle(latest.current.state);
    return () => {
      io?.disconnect();
      onScreen?.disconnect();
      controllerRef.current = null;
      watchRef.current = null;
    };
  }, [row]);
  const layoutRef = useRef(layout);
  useEffect(() => {
    if (layoutRef.current === layout) return;
    layoutRef.current = layout;
    watchRef.current?.();
  }, [layout]);
  const { more, loading, count, enabled } = state;
  useEffect(() => {
    controllerRef.current?.settle({ more, loading, count, enabled });
  }, [more, loading, count, enabled]);
  return setRow;
}

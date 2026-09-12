/**
 * Lends a slot's rectangle to the frame that `hostedIframe` keeps alive.
 *
 * The pane renders an empty box where the page should appear; this hook keeps
 * the real frame parked over that box. It never returns the element, because a
 * caller holding it would be tempted to put it in the tree - which is the one
 * thing that reloads it.
 *
 * WHY FOUR SIGNALS AND NOT ONE. The slot moves for reasons that fire different
 * events, and missing any of them leaves the page visibly out of place:
 * a split drag resizes the slot (ResizeObserver), the window resizes
 * (`resize`), an ancestor scrolls (`scroll`, captured, because scroll does not
 * bubble), and a layout that changes without touching any of the three - a tab
 * switch, a sidebar collapse, an animation settling - is caught by the poll.
 * The poll is the backstop the native path also keeps, and it costs one
 * `getBoundingClientRect` per visible browser pane.
 *
 * WHY LAYOUT EFFECTS AND NOT EFFECTS. A cross-group move lands the pane in a
 * DIFFERENT cell, so the frame's old rectangle is the wrong one the instant the
 * new pane mounts. With a plain effect the placement happens after the browser
 * has already painted that frame: for one frame the page sits over the cell it
 * came from and the new cell shows the pane's connecting state underneath.
 * Measured - REORD-03 counted a loader the user could actually see. A layout
 * effect runs before paint, so the frame is over its new slot in the same frame
 * the slot appears in.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { placeHostedFrame, releaseHostedFrame, retainHostedFrame } from './hostedIframe';

/** Backstop cadence for layout changes that fire no event of their own. */
const POLL_MS = 250;

export function useHostedFrame(
  contextId: string,
  url: string,
  slotRef: RefObject<HTMLElement | null>,
  active: boolean,
  visible: boolean,
): void {
  // The frame's LIFETIME, kept apart from its position on purpose: it must not
  // depend on `visible`, or switching to another tab in the same strip would
  // tear the page down and rebuild it on the way back - the very cost this is
  // here to remove. A hidden pane keeps its frame and merely stops being given
  // a rectangle.
  useLayoutEffect(() => {
    if (!active || !url) return;
    retainHostedFrame(contextId, url);
    return () => releaseHostedFrame(contextId);
  }, [contextId, url, active]);

  useLayoutEffect(() => {
    if (!active || !url) return;
    const place = (): void => {
      const slot = slotRef.current;
      // No slot, or not visible: no rectangle. `placeHostedFrame` reads that as
      // "hide", which is also what a zero-area rect means.
      placeHostedFrame(contextId, visible && slot ? slot.getBoundingClientRect() : null);
    };
    place();

    const slot = slotRef.current;
    const observer = new ResizeObserver(place);
    if (slot) observer.observe(slot);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const poll = window.setInterval(place, POLL_MS);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.clearInterval(poll);
    };
  }, [contextId, url, active, visible, slotRef]);
}

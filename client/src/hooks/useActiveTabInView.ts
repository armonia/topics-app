import { useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from '../lib/reducedMotion';

/**
 * Keeps the active tab of a strip that scrolls sideways in view: the tab bar
 * of the layout, and the bar of a topic's browser window.
 *
 * The FIRST positioning (mount, reload) is instant: a strip that was scrolled
 * comes back scrolled instead of sliding over from 0, and a layout effect lands
 * it before the first paint. Later switches animate, unless the system asks for
 * reduced motion: the media queries in `index.css` switch off CSS transitions,
 * but a scroll driven from script never sees them
 * (`tests/e2e/reduced-motion-chrome-controls.spec.ts` measures both).
 *
 * The strip's OWN scrollLeft, never `element.scrollIntoView()`: a freshly
 * mounted tab can still be 0 wide when this runs, and the browser's walk up the
 * ancestors then escapes the strip onto a distant overflow-hidden ancestor,
 * scrolling whole panes out of view with no scrollbar to bring them back.
 *
 * `activeSelector` finds the active tab inside the strip: null when there is
 * none, or when the strip is not on screen to be measured.
 */
export function useActiveTabInView(strip: RefObject<HTMLElement | null>, activeSelector: string | null): void {
  const positioned = useRef(false);
  useLayoutEffect(() => {
    const container = strip.current;
    if (!activeSelector || !container) return;
    const tab = container.querySelector<HTMLElement>(activeSelector);
    if (!tab) return;
    const behavior: ScrollBehavior = positioned.current && !prefersReducedMotion() ? 'smooth' : 'auto';
    const bar = container.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (box.left < bar.left) container.scrollBy({ left: box.left - bar.left, behavior });
    else if (box.right > bar.right) container.scrollBy({ left: box.right - bar.right, behavior });
    positioned.current = true;
  }, [strip, activeSelector]);
}

import { useCallback, useRef, useState, type CSSProperties } from 'react';

/** How far in from the edge the content fades out. */
const FADE_PX = 32;

/**
 * A ref callback that calls `measure(el)` with the element after every render
 * (React hands a new callback each time, so a change of content is measured)
 * and whenever the element's own box changes (the window was resized). The
 * layer cannot run effects, and a ref callback is what reads the layout
 * without one. `measure` must set state only when what it read changed.
 */
export function useMeasuredRef<T extends HTMLElement>(measure: (el: T) => void): (el: T | null) => void {
  const element = useRef<T | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const latest = useRef(measure);
  latest.current = measure;
  return (el) => {
    element.current = el;
    if (!el) {
      observer.current?.disconnect();
      return;
    }
    latest.current(el);
    if (typeof ResizeObserver === 'undefined') return;
    observer.current ??= new ResizeObserver(() => {
      if (element.current) latest.current(element.current);
    });
    observer.current.observe(el);
  };
}

const edgesOf = (el: HTMLElement) => ({
  start: el.scrollLeft > 1,
  end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
});

/**
 * Makes a strip that scrolls sideways say so: on each side that still hides
 * content the edge fades out, so a word cut at the edge is never read as the
 * end of the strip. A mask on the strip itself, so it works on any background.
 * It reads its own box (scroll position and size) and its entries' boxes,
 * when it mounts, when one of them is resized and when it scrolls.
 *
 * No ref is read while rendering: the callbacks are stable and the edges are
 * state, so React can render the strip as often as it likes.
 *
 * Put `attach` (as its ref), `style` and `onScroll` on the element that scrolls; give it
 * `scroll-px-8` so an entry brought into view is not left under the fade.
 */
export function useScrollFade<T extends HTMLElement>() {
  const [edges, setEdges] = useState({ start: false, end: false });
  const update = useCallback((el: T) => {
    const next = edgesOf(el);
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);
  const ref = useCallback((el: T | null) => {
    if (!el) return undefined;
    update(el);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => update(el));
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    // React 19 runs the function a ref callback returns when the element goes away.
    return () => observer.disconnect();
  }, [update]);
  const onScroll = useCallback((e: { currentTarget: T }) => update(e.currentTarget), [update]);
  const { start, end } = edges;
  const mask = start && end
    ? `linear-gradient(to right, transparent, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), transparent)`
    : start
      ? `linear-gradient(to right, transparent, #000 ${FADE_PX}px)`
      : end
        ? `linear-gradient(to left, transparent, #000 ${FADE_PX}px)`
        : undefined;
  const style: CSSProperties | undefined = mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined;
  return { attach: ref, style, onScroll };
}

/**
 * Brings `el` into view along its strip, sideways only. `scrollIntoView`
 * would also scroll every box above it to show it, so a strip in the middle of
 * a long page dragged the page down with it (the contract opened scrolled on a
 * phone). `pad` keeps the entry out of the faded edge.
 */
export function revealInStrip(el: HTMLElement | null, pad = FADE_PX) {
  const strip = el?.parentElement;
  if (!el || !strip) return;
  const s = strip.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.left < s.left + pad) strip.scrollLeft -= s.left + pad - r.left;
  else if (r.right > s.right - pad) strip.scrollLeft += r.right - (s.right - pad);
}

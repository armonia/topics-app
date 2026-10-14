import { useEffect, useState, type RefObject } from 'react';

export interface Rect { left: number; top: number; width: number; height: number }

export type AreaRef = RefObject<HTMLElement | null>;

/** The topic area where `position: fixed` puts the window, kept fresh across
 *  resizes, scrolls and layout changes of the cell itself.
 *
 *  Measured against a fixed box at (0, 0), not taken as the area's client rect:
 *  the two agree almost everywhere, not on an iPad with the keyboard up. There
 *  Safari shortens the viewport and scrolls the whole page to show the field;
 *  the rects follow that scroll and the fixed origin does not (337 px upright,
 *  422 lying down, on an 11-inch). Placed at the client rect, the window sat that
 *  much above the chat beside it, and lying down it left the screen: the topic's
 *  browser vanished with every keyboard (14/10). */
export function useAreaRect(areaRef: AreaRef): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const origin = el.ownerDocument.createElement('div');
    origin.setAttribute('aria-hidden', 'true');
    origin.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none';
    // Where the window lives (it is portalled to the body), so a containing
    // block the body makes for fixed boxes moves both alike.
    el.ownerDocument.body.appendChild(origin);
    const read = (): void => {
      const r = el.getBoundingClientRect();
      const o = origin.getBoundingClientRect();
      const left = r.left - o.left;
      const top = r.top - o.top;
      setRect((prev) => (prev && prev.left === left && prev.top === top && prev.width === r.width && prev.height === r.height
        ? prev
        : { left, top, width: r.width, height: r.height }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    const viewport = window.visualViewport;
    window.addEventListener('resize', read);
    window.addEventListener('scroll', read, true);
    viewport?.addEventListener('resize', read);
    viewport?.addEventListener('scroll', read);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', read);
      window.removeEventListener('scroll', read, true);
      viewport?.removeEventListener('resize', read);
      viewport?.removeEventListener('scroll', read);
      origin.remove();
    };
  }, [areaRef]);
  return rect;
}

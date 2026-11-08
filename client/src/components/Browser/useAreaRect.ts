import { useEffect, useState, type RefObject } from 'react';
import { fixedFrame } from '../../lib/fixedFrame';

export interface Rect { left: number; top: number; width: number; height: number }

export type AreaRef = RefObject<HTMLElement | null>;

/** The topic area where `position: fixed` puts the window, kept fresh across
 *  resizes, scrolls and layout changes of the cell itself.
 *
 *  In the fixed frame, not as the area's client rect: the two agree almost
 *  everywhere, not on an iPad with the keyboard up (`lib/fixedFrame`). Placed at
 *  the client rect, the window sat 422 px above the chat beside it, and lying
 *  down it left the screen: the topic's browser vanished with every keyboard
 *  (14/10). */
export function useAreaRect(areaRef: AreaRef): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const read = (): void => {
      const r = el.getBoundingClientRect();
      const o = fixedFrame(el.ownerDocument);
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
    };
  }, [areaRef]);
  return rect;
}

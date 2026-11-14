import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A horizontal scroller that SAYS it scrolls: the edge with more content
 * behind it fades out.
 *
 * A wide markdown table on a phone scrolls inside its own box (the page never
 * does), but iOS hides the scrollbar, so the cut at the right edge read as
 * content that had been chopped off (feedback on the phone pass, 14/11). The
 * fade is a `mask-image`, not a gradient painted in a background colour, so it
 * is right on every surface the transcript sits on, in both themes.
 *
 * The state lives in a `data-fade` attribute written straight to the DOM: it
 * changes on every scroll frame, and a React state there would re-render the
 * table it wraps for nothing.
 */
export function ScrollFadeX({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const left = el.scrollLeft > 1;
      const right = max > 1 && el.scrollLeft < max - 1;
      const next = left && right ? 'both' : left ? 'left' : right ? 'right' : '';
      if (next) el.setAttribute('data-fade', next);
      else el.removeAttribute('data-fade');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className={`scroll-fade-x overflow-x-auto ${className}`}>
      {children}
    </div>
  );
}

/**
 * The one tooltip of the preview, drawn by the app instead of the browser.
 *
 * The components of `client/src/ui/` never write `title=`: the browser's
 * tooltip comes late (over a second on macOS), cannot be styled and holds one
 * line. They write `data-tip="…"` (`data-tip-side="above"` to prefer the top,
 * `data-tip-clipped` to show it only while a `.truncate` label inside is cut)
 * and this layer, mounted once by the container, draws it: the same look and
 * timing as the product's `components/Shared/TooltipDelegate.tsx` (350 ms to
 * open, 120 ms to close, under the element unless there is no room, closed by
 * a press, Escape or a scroll). `scripts/check-ui-native.mjs` keeps `title=`
 * out of the sources and the build.
 *
 * While it shows, the element points at it with `aria-describedby`, so a
 * screen reader reads the same words; the attribute is put back as it was
 * when the tooltip closes. Listeners are added once and removed on unmount:
 * navigating never adds more.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const OPEN_MS = 350;
const CLOSE_MS = 120;
const GAP = 6;
const MARGIN = 8;
const TIP_ID = 'app-tooltip';

interface Shown {
  text: string;
  rect: DOMRect;
  above: boolean;
  /** Where the pointer entered, for an element too wide to centre the tip on: the tip sits under the pointer, not under the middle of the row. */
  pointerX?: number;
}

/** Wider than this, an element is a row or a bar: the tip follows where the pointer is. */
const WIDE_PX = 320;

/** Whether a label inside `el` is cut with «…»: the tip of a tab or a row then carries the whole name. */
function isClipped(el: HTMLElement): boolean {
  const label = el.matches('.truncate') ? el : el.querySelector<HTMLElement>('.truncate');
  return !!label && label.scrollWidth > label.clientWidth + 1;
}

/** The element under the pointer that carries a tip, disabled controls included. `data-tip-clipped` asks for the tip only while a label inside is cut. */
function tipOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('[data-tip]');
  if (!el || !el.dataset.tip?.trim()) return null;
  return el.dataset.tipClipped !== undefined && !isClipped(el) ? null : el;
}

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    /** The element the tooltip belongs to, and its own `aria-describedby` to put back. */
    let held: { el: HTMLElement; described: string | null } | null = null;
    let enteredAt: number | undefined;

    const stop = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const release = () => {
      if (!held) return;
      const { el, described } = held;
      if (described === null) el.removeAttribute('aria-describedby');
      else el.setAttribute('aria-describedby', described);
      held = null;
    };
    const hide = () => {
      stop();
      release();
      setShown(null);
    };

    const onOver = (e: Event) => {
      const el = tipOf(e.target);
      if (!el) return;
      if (held?.el === el) {
        stop();
        return;
      }
      release();
      held = { el, described: el.getAttribute('aria-describedby') };
      enteredAt = (e as MouseEvent).clientX;
      stop();
      timer = window.setTimeout(() => {
        if (!held || held.el !== el || !el.isConnected) return;
        el.setAttribute('aria-describedby', [held.described, TIP_ID].filter(Boolean).join(' '));
        setPos(null);
        const rect = el.getBoundingClientRect();
        setShown({ text: el.dataset.tip ?? '', rect, above: el.dataset.tipSide === 'above', pointerX: rect.width > WIDE_PX ? enteredAt : undefined });
      }, OPEN_MS);
    };
    const onOut = (e: Event) => {
      if (!held) return;
      const to = (e as MouseEvent).relatedTarget;
      if (to instanceof Node && held.el.contains(to)) return;
      stop();
      timer = window.setTimeout(hide, CLOSE_MS);
    };
    /* Keyboard focus shows it at once, as the product does for a focused control. */
    const onFocus = (e: Event) => {
      const el = tipOf(e.target);
      if (!el || !(e.target as Element).matches(':focus-visible')) return;
      release();
      held = { el, described: el.getAttribute('aria-describedby') };
      el.setAttribute('aria-describedby', [held.described, TIP_ID].filter(Boolean).join(' '));
      setPos(null);
      setShown({ text: el.dataset.tip ?? '', rect: el.getBoundingClientRect(), above: el.dataset.tipSide === 'above' });
    };
    const onBlur = () => { if (held) hide(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && held) hide(); };
    const onScroll = () => { if (held) hide(); };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onBlur, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      stop();
      release();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onBlur, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  /* Placed after it is drawn, when its size is known: under the element, above it when there is no room (or asked). */
  useLayoutEffect(() => {
    if (!shown || !tipRef.current) return;
    const a = shown.rect;
    const t = tipRef.current.getBoundingClientRect();
    const below = a.bottom + GAP;
    const above = a.top - t.height - GAP;
    const roomBelow = below + t.height <= window.innerHeight - MARGIN;
    const top = (shown.above && above >= MARGIN) || (!roomBelow && above >= MARGIN) ? above : below;
    const middle = shown.pointerX ?? a.left + a.width / 2;
    const left = Math.max(MARGIN, Math.min(middle - t.width / 2, window.innerWidth - t.width - MARGIN));
    setPos({ top: Math.max(MARGIN, top), left });
  }, [shown]);

  if (!shown) return null;
  return (
    <div
      ref={tipRef}
      id={TIP_ID}
      role="tooltip"
      className="pointer-events-none fixed z-[10001] max-w-sm whitespace-pre-line rounded-lg border border-app-border bg-elevated px-2.5 py-1.5 text-mini leading-snug text-app-text shadow-lg popover-enter"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      {shown.text}
    </div>
  );
}

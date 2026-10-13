/**
 * Scrolling the DOM mirror on this device first (BROWSER-DOM-SCROLL-01).
 *
 * The mirror used to move only when the source's own scroll came back: the
 * gesture went to the Mac, the Mac scrolled, its recorder sampled the scroll
 * every 100ms, and the replayer animated to it. On the iPad that is a third of
 * a second behind the finger. The mirror is a real document, so it can scroll
 * itself by the same distance the source is asked to, and the source follows.
 */

/** The moves a fling's speed is read from, and how old the last one may be. */
const FLING_WINDOW_MS = 100;
const FLING_STALE_MS = 50;

/**
 * What a gesture at (x, y) scrolls in the mirror's document: the nearest
 * ancestor that can scroll along the gesture's axis, else the page itself.
 */
export function scrollTargetAt(doc: Document, x: number, y: number, horizontal: boolean): Element | null {
  const view = doc.defaultView;
  for (let el = doc.elementFromPoint(x, y); el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    const style = view?.getComputedStyle(el);
    const overflow = horizontal ? style?.overflowX : style?.overflowY;
    const room = horizontal ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight;
    if (room && (overflow === 'auto' || overflow === 'scroll')) return el;
  }
  return doc.scrollingElement;
}

/**
 * The finger's speed at release, in source px per ms, from its moves over the
 * last 100ms. A finger that stopped before lifting flings nothing.
 */
export function flingVelocity(moves: readonly { t: number; dx: number; dy: number }[], now: number): { vx: number; vy: number } {
  const recent = moves.filter((m) => now - m.t <= FLING_WINDOW_MS);
  const last = recent[recent.length - 1];
  if (recent.length < 2 || now - last.t > FLING_STALE_MS) return { vx: 0, vy: 0 };
  const span = last.t - recent[0].t;
  if (span <= 0) return { vx: 0, vy: 0 };
  // Each move is the distance since the one before it: the first one's falls outside the span.
  let dx = 0;
  let dy = 0;
  for (let i = 1; i < recent.length; i++) {
    dx += recent[i].dx;
    dy += recent[i].dy;
  }
  return { vx: dx / span, vy: dy / span };
}

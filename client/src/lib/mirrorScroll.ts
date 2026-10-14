/**
 * Scrolling the DOM mirror on this device first (BROWSER-DOM-SCROLL-01).
 *
 * The mirror used to move only when the source's own scroll came back: the
 * gesture went to the Mac, the Mac scrolled, its recorder sampled the scroll
 * every 100ms, and the replayer animated to it. On the iPad that is a third of
 * a second behind the finger. The mirror is a real document, so it can scroll
 * itself by the same distance the source is asked to, and the source follows.
 */
import { sameAnchor, type ScrollAnchor } from './mirrorLayout';

/** The moves a fling's speed is read from, and how old the last one may be. */
const FLING_WINDOW_MS = 100;
const FLING_STALE_MS = 50;

/** rrweb's IncrementalSnapshot event type, and the source of its scroll events. */
const INCREMENTAL_SNAPSHOT = 3;
const SCROLL_SOURCE = 3;
/** How long this device's own scroll wins over the source's echoes of it. */
const LOCAL_SCROLL_HOLD_MS = 600;
/** How long the mirror waits, after a relay, for the source to reach where it scrolled. */
const SCROLL_CONFIRM_MS = 2000;

/**
 * Put `el` at (top, left) now. The page's own `scroll-behavior: smooth`, which
 * the mirror carries too, would animate a plain assignment: the scroll read as
 * not having happened yet, and the source's echoes were let through under it.
 */
export function scrollInstantly(el: Element, top: number, left: number): void {
  try {
    el.scrollTo({ top, left, behavior: 'instant' });
  } catch {
    el.scrollTop = top;
    el.scrollLeft = left;
  }
}

/**
 * Scroll `el` by (dx, dy) from `pos`, where this device means it to be. WebKit
 * keeps whole pixels, and 2.7 px a frame moved the mirror 2 while the source,
 * summing a batch, moved 10 of 10.8: the fractions stay in `pos`. Whatever
 * else moved `el` (an echo, the edge) starts it over from where it is.
 */
export function scrollKeepingFractions(
  el: Element,
  pos: { top: number; left: number } | null,
  dx: number,
  dy: number,
): { pos: { top: number; left: number }; moved: boolean } {
  const { scrollTop, scrollLeft } = el;
  const from = pos && Math.abs(pos.top - scrollTop) < 1 && Math.abs(pos.left - scrollLeft) < 1
    ? pos
    : { top: scrollTop, left: scrollLeft };
  const next = { top: from.top + dy, left: from.left + dx };
  scrollInstantly(el, Math.round(next.top), Math.round(next.left));
  return { pos: next, moved: el.scrollTop !== scrollTop || el.scrollLeft !== scrollLeft };
}

/**
 * What this device scrolled, by the id the source's recorder gave it, and where
 * it put it: a pixel, or for a mirror laid out at its own size the place its
 * content names (lib/mirrorLayout), which the source sends back as it got it.
 */
export interface ScrollPlace {
  node: number;
  top: number;
  left: number;
  anchor?: ScrollAnchor;
}

type Echo = { type: number; data?: { source?: number; id?: number; x?: number; y?: number; anchor?: ScrollAnchor } };

/** Is this echo the source standing where the mirror put it? */
function confirms(event: Echo, place: ScrollPlace): boolean {
  if (place.anchor) return sameAnchor(event.data?.anchor, place.anchor);
  return Math.abs((event.data?.y ?? 0) - place.top) < 1 && Math.abs((event.data?.x ?? 0) - place.left) < 1;
}

export interface EchoHold<E extends Echo> {
  /** The mirror just moved itself: the gesture goes on. */
  moved(): void;
  /** Until the gesture's hold is over: a wheel after it is a new gesture. */
  gesturing(): boolean;
  /** The place just relayed to the source. */
  relayed(place: ScrollPlace): void;
  /** An event from the source: true when it is held, for the applier to receive later. */
  hold(event: E): boolean;
  /** Who applies the held echoes once their wait is over (the replayer, while it lives). */
  applyWith(apply: ((events: E[]) => void) | null): void;
  clear(): void;
}

/**
 * The source's echoes of a scroll this device makes itself. Applied as they
 * come, they drag the mirror back to where the source was a round trip ago
 * (BROWSER-DOM-SCROLL-01). They wait for the gesture to end and, for the node
 * it scrolled, for the source to report the place relayed to it
 * (BROWSER-DOM-SCROLL-02): a busy Mac answers late, and its older echoes are
 * not where it is going. Only the latest per node is applied, once its wait is
 * over: where the source really ended up, if that is somewhere else.
 */
export function createEchoHold<E extends Echo>(opts: {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
} = {}): EchoHold<E> {
  const now = opts.now ?? (() => performance.now());
  const schedule = opts.schedule ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  });
  let until = 0;
  let relayed: ScrollPlace | null = null;
  let confirmBy = 0;
  const held = new Map<number, E>();
  let cancel: (() => void) | null = null;
  let releaseAt = 0;
  let apply: ((events: E[]) => void) | null = null;

  const heldUntil = (id: number, t: number): number => {
    if (t < until) return until;
    return relayed?.node === id && t < confirmBy ? confirmBy : 0;
  };
  const scheduleRelease = (at: number, t: number): void => {
    if (cancel && releaseAt <= at) return;
    cancel?.();
    releaseAt = at;
    cancel = schedule(release, at - t + 16);
  };
  function release(): void {
    cancel = null;
    const t = now();
    const due: E[] = [];
    for (const [id, event] of held) {
      const at = heldUntil(id, t);
      if (at > t) scheduleRelease(at, t);
      else {
        held.delete(id);
        due.push(event);
      }
    }
    if (due.length) apply?.(due);
  }

  return {
    moved() { until = now() + LOCAL_SCROLL_HOLD_MS; },
    gesturing: () => now() <= until,
    relayed(place) {
      relayed = place;
      confirmBy = now() + SCROLL_CONFIRM_MS;
    },
    hold(event) {
      const id = event.data?.id;
      if (event.type !== INCREMENTAL_SNAPSHOT || event.data?.source !== SCROLL_SOURCE || typeof id !== 'number') return false;
      if (relayed?.node === id && confirms(event, relayed)) {
        // The source is where the mirror put it: nothing left to wait for.
        relayed = null;
      }
      const t = now();
      const at = heldUntil(id, t);
      if (at <= t) {
        // Newer than what is held for this node, which must not land after it.
        held.delete(id);
        return false;
      }
      held.set(id, event);
      scheduleRelease(at, t);
      return true;
    },
    applyWith(next) { apply = next; },
    clear() {
      cancel?.();
      cancel = null;
      held.clear();
    },
  };
}

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

import type { ClientRect, UniqueIdentifier } from '@dnd-kit/core';

/**
 * DROPPABLE RECTS READ ONCE PER SCROLL, NOT FOUR TIMES PER DROPPABLE PER MOVE.
 *
 * dnd-kit measures every droppable when a drag starts and keeps it as a `Rect`
 * whose `top`, `left`, `right` and `bottom` are GETTERS: each read sums the
 * `scrollTop`/`scrollLeft` of every scrollable ancestor of that droppable, so
 * the rect follows a column that scrolled after the measurement. The built-in
 * collision algorithms read those getters for every droppable on every pointer
 * move (`pointerWithin` four times each). Measured on a 33-card board
 * (board-drag-frames.spec.ts with a counting wrapper): about 420 scroll-offset
 * reads per move, 30,000 per 60-move pass, each one a forced style-and-layout
 * check, and the largest single cost of the drag after React.
 *
 * What changes a getter's value is only a scroll of one of its ancestors, and
 * every scroll fires a `scroll` event, which a capture listener on `window`
 * sees for any element. So a rect is copied into a plain object (two getter
 * reads: `right` and `bottom` follow from `width` and `height`, which are plain
 * fields) and the copy is reused until the next scroll. A droppable measured
 * again is a new `Rect`, hence a new key: the cache cannot hand back a stale
 * measurement. The event arrives with the next frame, the same moment
 * dnd-kit's own scroll tracking (which moves the dragged rect) catches up, so
 * the two sides of the comparison stay in step.
 */

/** Bumped on every scroll anywhere in the page: copies of an older generation are read again. */
let generation = 0;
let listening = false;
const cache = new WeakMap<ClientRect, { generation: number; rect: ClientRect }>();

/** A scroll moved some droppable's ancestors: every copy is stale. Exported for the tests. */
export function invalidateSettledRects(): void {
  generation += 1;
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('scroll', invalidateSettledRects, { capture: true, passive: true });
}

/** The rect as plain numbers, as its getters would read now. */
export function settleRect(rect: ClientRect): ClientRect {
  const hit = cache.get(rect);
  if (hit && hit.generation === generation) return hit.rect;
  const { top, left, width, height } = rect;
  const plain = { top, left, width, height, right: left + width, bottom: top + height };
  cache.set(rect, { generation, rect: plain });
  return plain;
}

/** The droppable rects of one collision pass, as plain copies the algorithms can read for free. */
export function settledRects(rects: Map<UniqueIdentifier, ClientRect>): Map<UniqueIdentifier, ClientRect> {
  listen();
  const out = new Map<UniqueIdentifier, ClientRect>();
  for (const [id, rect] of rects) out.set(id, settleRect(rect));
  return out;
}

/*
 * Where a floating surface that hangs off a control goes: under it, or over it
 * when the foot of the screen would cut it, and kept inside the screen on the
 * sides. It reads layout only (the control's box and the size of its page, as
 * `Menu`'s `sideFor` does) and the result is fixed coordinates, so a clipping
 * ancestor (a scrolling column, a dialog body) cannot cut the surface.
 */

/** Space kept between a floating surface and the edge of the screen. */
const EDGE = 8;
/** Space between the control and its surface. */
const GAP = 4;

export interface FloatBox {
  left: number;
  width: number;
  /** Set when the surface hangs under the control. */
  top?: number;
  /** Set when the surface stands over the control (distance from the screen's foot). */
  bottom?: number;
  /** The most height the chosen side offers. */
  maxHeight: number;
}

/** Whether the page is driven by a finger: rows and cells grow to the touch size. */
export function isCoarse(el: HTMLElement): boolean {
  return !!el.ownerDocument.defaultView?.matchMedia('(pointer: coarse)').matches;
}

/**
 * `width` is the width the surface wants (it is narrowed to fit the screen),
 * `height` the height it would take if nothing cut it.
 */
export function placeFloat(anchor: HTMLElement, wanted: { width: number; height: number }): FloatBox {
  const view = anchor.ownerDocument.defaultView;
  const r = anchor.getBoundingClientRect();
  const screenW = view?.innerWidth ?? 1024;
  const screenH = view?.innerHeight ?? 768;
  const width = Math.min(wanted.width, screenW - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(r.left, screenW - width - EDGE));
  const below = screenH - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  if (wanted.height > below && above > below) {
    return { left, width, bottom: screenH - r.top + GAP, maxHeight: Math.max(above, 120) };
  }
  return { left, width, top: r.bottom + GAP, maxHeight: Math.max(below, 120) };
}

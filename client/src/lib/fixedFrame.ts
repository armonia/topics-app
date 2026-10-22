/**
 * Where `position: fixed` lays boxes out, in client coordinates.
 *
 * The window, almost everywhere: there a popover fixed at `top: anchor.bottom`
 * hangs under its anchor, because the anchor's rect and the fixed box share one
 * origin. Not on an iPad with the keyboard up. Safari shortens the viewport and
 * scrolls the whole page to show the field, fixed boxes included (422 px lying
 * down, 337 upright, on an 11-inch, measured 14/10). The anchor's rect follows
 * that scroll, and a box fixed at it counts the scroll a second time: the
 * topic's browser window left the screen that way, and so did every menu,
 * picker and sheet opened while typing (`/effort`, `/context`, the autonomy
 * picker, the composer's «+»).
 *
 * So a fixed box is placed in client coordinates, as before, and only the CSS
 * it gets is moved into this frame: `top: y - frame.top`, `left: x -
 * frame.left`, `bottom: frame.bottom - y`. Measured on a probe in the body,
 * where the popovers are portalled, so a containing block the body makes for
 * fixed boxes moves both alike.
 */
export interface FixedFrame {
  left: number;
  top: number;
  bottom: number;
}

const probes = new WeakMap<Document, HTMLElement>();

export function fixedFrame(doc: Document = document): FixedFrame {
  let probe = probes.get(doc);
  if (!probe?.isConnected) {
    probe = doc.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('data-fixed-frame', '');
    probe.style.cssText = 'position:fixed;left:0;top:0;bottom:0;width:0;visibility:hidden;pointer-events:none';
    doc.body.appendChild(probe);
    probes.set(doc, probe);
  }
  const r = probe.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom };
}

/** A point placed in client coordinates, as the `top`/`left` a fixed box needs to stand there. Other fields pass through. */
export function toFixed<T extends { top: number; left: number }>(at: T, doc?: Document): T {
  const frame = fixedFrame(doc);
  return { ...at, top: at.top - frame.top, left: at.left - frame.left };
}

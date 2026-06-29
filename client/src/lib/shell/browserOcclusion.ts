// Browser occlusion — keep HTML overlays above native browser webviews (Tauri).
//
// A native child webview (Tauri multi-webview / Electron WebContentsView) ALWAYS
// composites above the React DOM — no z-index can lift a dropdown/menu/modal over
// it. Electron solves this with separate always-on-top overlay windows
// (electronAPI.overlay / overlayHost). The Tauri shell substitutes a pixel still:
// a pane that an overlay actually covers freezes to a DOM <img> and parks the live
// view, so the overlay composites over the still by normal z-index (see
// useTauriBrowser.freeze).
//
// We track overlays structurally (no edits to every popover primitive): the
// canonical popover is a `.glass-surface` card (lib/popoverStyles), modals carry
// `role="dialog"`, and menus/listboxes carry their ARIA roles. A cheap
// MutationObserver collects their RECTS so each pane can decide whether it is
// actually intersected — a menu nowhere near a browser pane must NOT touch it
// (the old global "any overlay hides every pane" was over-broad).

import { isTauri } from './index';

/** Selector matching any HTML overlay that can float over a browser pane. */
const OVERLAY_SELECTOR =
  '.glass-surface, [role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

/** Viewport-relative rect of an open overlay. */
export interface OverlayRect { left: number; top: number; right: number; bottom: number; }

let overlays: OverlayRect[] = [];
let lastKey = '';
const listeners = new Set<(overlays: OverlayRect[]) => void>();
let started = false;
let scheduled = false;

function recompute(): void {
  scheduled = false;
  const next: OverlayRect[] = [];
  document.querySelectorAll(OVERLAY_SELECTOR).forEach((el) => {
    const node = el as HTMLElement;
    // Never let a browser pane occlude ITSELF: skip overlays that live inside a
    // native browser slot (e.g. the pane's own responsive size-readout, which is
    // a `.glass-surface` positioned over the slot). Without this, that in-pane
    // chrome rect-overlaps the slot and freezes the live view to a static still
    // that never thaws — a dead/frozen-looking browser. Structural, so any future
    // in-pane glass chrome is covered too.
    if (node.closest('[data-native-browser-slot]')) return;
    // Ignore hidden overlays (display:none yields no client rects; a
    // visibility:hidden / opacity:0 card paints nothing yet still has a rect).
    if (node.getClientRects().length === 0) return;
    const cs = getComputedStyle(node);
    if (cs.visibility === 'hidden' || cs.opacity === '0') return;
    const r = node.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) next.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  });
  const key = next
    .map((r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`)
    .sort()
    .join('|');
  if (key === lastKey) return;
  lastKey = key;
  overlays = next;
  for (const fn of listeners) fn(overlays);
}

/** Pure: does `slot` (viewport-rel x/y/width/height) intersect any of `rects`?
 *  Exported for unit tests; `slotIsOccluded` applies it to the live overlay set. */
export function slotIntersectsRects(
  slot: { x: number; y: number; width: number; height: number },
  rects: readonly OverlayRect[],
): boolean {
  if (slot.width <= 0 || slot.height <= 0) return false;
  const r = slot.x + slot.width;
  const b = slot.y + slot.height;
  return rects.some((o) => o.left < r && o.right > slot.x && o.top < b && o.bottom > slot.y);
}

/** True if `slot` intersects any currently-open overlay. */
export function slotIsOccluded(slot: { x: number; y: number; width: number; height: number }): boolean {
  return slotIntersectsRects(slot, overlays);
}

/** Subscribe to overlay-set changes (open/close/move). The callback gets the
 *  current overlay rects; consumers decide intersection per pane. Returns an
 *  unsubscribe fn. Lazily starts the observer on first subscription (Tauri). */
export function onOcclusionChange(fn: (overlays: OverlayRect[]) => void): () => void {
  if (isTauri) startObserver();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function startObserver(): void {
  if (started || typeof document === 'undefined') return;
  started = true;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // Debounce: many DOM churns (streaming chat) collapse to one recount.
    window.setTimeout(recompute, 30);
  };

  // Only schedule when an added/removed node could be (or contain) an overlay —
  // skips the constant text-node churn of streaming chat.
  const relevant = (nodes: NodeList): boolean => {
    for (const n of Array.from(nodes)) {
      if (n instanceof Element && (n.matches(OVERLAY_SELECTOR) || n.querySelector(OVERLAY_SELECTOR))) {
        return true;
      }
    }
    return false;
  };

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (relevant(m.addedNodes) || relevant(m.removedNodes)) {
        schedule();
        return;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // Initial state (in case an overlay is already open at subscribe time).
  recompute();
}

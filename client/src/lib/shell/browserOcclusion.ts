// Browser occlusion — keep HTML overlays above native browser webviews (Tauri).
//
// A native child webview (Tauri multi-webview / Electron WebContentsView) ALWAYS
// composites above the React DOM — no z-index can lift a dropdown/menu/modal over
// it. Electron solves this with separate always-on-top overlay windows
// (electronAPI.overlay / overlayHost). The Tauri shell takes the pragmatic route:
// while any HTML overlay is open, PARK every native browser webview off-screen so
// the overlay shows through; restore when the last overlay closes.
//
// We detect overlays structurally (no edits to every popover primitive): the
// canonical popover is a `.glass-surface` card (lib/popoverStyles), modals carry
// `role="dialog"`, and menus/listboxes carry their ARIA roles. A cheap
// MutationObserver counts them; consumers (useTauriBrowser) gate their setBounds
// on `isOccluded()` and re-apply on change.

import { isTauri } from './index';

/** Selector matching any HTML overlay that can float over a browser pane. */
const OVERLAY_SELECTOR =
  '.glass-surface, [role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

let occluded = false;
const listeners = new Set<(occluded: boolean) => void>();
let started = false;
let scheduled = false;

function recompute(): void {
  scheduled = false;
  const next = document.querySelectorAll(OVERLAY_SELECTOR).length > 0;
  if (next === occluded) return;
  occluded = next;
  for (const fn of listeners) fn(occluded);
}

/** True while a dropdown/menu/modal is open and a browser webview must hide. */
export function isOccluded(): boolean {
  return occluded;
}

/** Subscribe to occlusion transitions. Returns an unsubscribe fn. Lazily starts
 *  the observer on first subscription (Tauri only). */
export function onOcclusionChange(fn: (occluded: boolean) => void): () => void {
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

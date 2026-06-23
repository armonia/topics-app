/**
 * browserSuppress — coordinate hiding the native browser WebContentsView while
 * an HTML overlay is on screen.
 *
 * WHY THIS EXISTS: the native browser pane is an Electron `WebContentsView`, an
 * OS-level child of the window that is composited ABOVE the entire React DOM.
 * z-index does nothing against it. So any React overlay that visually sits over
 * a browser pane — the ⌘K command palette, a full-screen modal, or one of the
 * browser toolbar's own dropdowns (console / device / history) — renders
 * UNDERNEATH the live page and is invisible. The only fix Electron offers is to
 * shrink the view to zero bounds (there is no `setVisible`), which is what
 * NativeBrowserPlaceholder already does for drag-and-drop.
 *
 * This module is the shared, ref-counted registry the placeholder listens to.
 * Two scopes:
 *   - GLOBAL (no viewId): hide EVERY native browser pane. For full-screen
 *     modals (⌘K, Settings, …) that cover the whole window — every pane is
 *     occluded anyway, so blanking them all is correct and invisible.
 *   - PER-VIEW (viewId): hide only that one pane. For the browser toolbar's own
 *     popovers, which overlap just their own pane — sibling browser panes in a
 *     split must keep rendering.
 *
 * No DOM MutationObserver: a body-subtree observer caused a documented FPS
 * regression here before. Suppression is driven explicitly by the overlay
 * components via `useSuppressNativeBrowser` / `acquireSuppress`.
 */
import { useEffect } from 'react';

export const BROWSER_SUPPRESS_EVENT = 'topics:browser-suppress-change';

export interface BrowserSuppressSnapshot {
  /** At least one full-screen overlay is open → hide all native browser panes. */
  global: boolean;
  /** Specific panes to hide (toolbar popovers), keyed by WebContentsView id. */
  viewIds: string[];
}

// token → the viewId it suppresses, or null for a global (all-pane) suppression.
const tokens = new Map<symbol, string | null>();

function snapshot(): BrowserSuppressSnapshot {
  let global = false;
  const ids = new Set<string>();
  for (const v of tokens.values()) {
    if (v === null) global = true;
    else ids.add(v);
  }
  return { global, viewIds: [...ids] };
}

function emit(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<BrowserSuppressSnapshot>(BROWSER_SUPPRESS_EVENT, { detail: snapshot() }),
  );
}

/**
 * Acquire a suppression. Pass a `viewId` to hide only that pane's native view;
 * omit it to hide every native browser pane (full-screen overlay). Returns a
 * release fn — call it when the overlay closes/unmounts. Idempotent.
 */
export function acquireSuppress(viewId?: string): () => void {
  const key = Symbol('browser-suppress');
  tokens.set(key, viewId ?? null);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    tokens.delete(key);
    emit();
  };
}

/** Current suppression state — for placeholders mounting while an overlay is already open. */
export function currentSuppressSnapshot(): BrowserSuppressSnapshot {
  return snapshot();
}

/**
 * Declarative wrapper: while `active` is true, suppress the native browser
 * (globally, or for one `viewId`). Releases automatically when `active` flips
 * false or the component unmounts. Drop this into any overlay component, gated
 * on its open state — e.g. `useSuppressNativeBrowser(isOpen)` for a modal, or
 * `useSuppressNativeBrowser(menuOpen, viewId)` for a per-pane toolbar popover.
 */
export function useSuppressNativeBrowser(active: boolean, viewId?: string): void {
  useEffect(() => {
    if (!active) return;
    return acquireSuppress(viewId);
  }, [active, viewId]);
}

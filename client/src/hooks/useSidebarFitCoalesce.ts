import { useEffect } from 'react';
import { isTauri } from '../lib/shell';

/**
 * Keeps the sidebar collapse/expand smooth. Two independent costs stack on a 200ms
 * sidebar `width` transition, both measured on a freed machine with 6 DOM terminals:
 *
 *  1. Per-frame xterm `fit()` (~+110ms): the content area resizes every frame, each
 *     terminal's ResizeObserver calls FitAddon.fit() per frame, and fit() forces a
 *     layout read + rebuilds the row DOM for the new column count. → coalesced here by
 *     dispatching `topics:sidebar-resize-start/-end` around the transition, which the
 *     terminal resize effect already brackets (same mechanism as a divider drag) to
 *     hold fits and run exactly one at the settled size. Platform-agnostic.
 *  2. Per-frame terminal LAYOUT (~340ms): even with fit held, the row DOM re-flows on
 *     every frame as the container width animates. → skipped via the CSS rule
 *     `html.sidebar-animating .xterm { content-visibility: hidden }` for the slide;
 *     the terminals lay out once when the class drops on transitionend. WebKit-only
 *     (Tauri) — it briefly blanks the terminal screen, and Chromium/Electron lays the
 *     rows out fast enough not to need it, so Electron is left untouched.
 *
 * Together: ~300ms → ~82ms (one settle layout+fit at the end). A separate event from
 * `pane-resize-*` is used so this doesn't fight useFloatingVibrancy's frost tracking,
 * which on the sidebar is owned by its own (candidate-A) transition handler.
 */
export function useSidebarFitCoalesce(): void {
  useEffect(() => {
    const root = document.documentElement;
    const sidebar = () =>
      document.querySelector<HTMLElement>('[role="navigation"][aria-label="Topics sidebar"]');
    const isSidebarWidth = (e: TransitionEvent) =>
      e.propertyName === 'width' && e.target instanceof Element && e.target === sidebar();

    let active = false;
    let safety = 0;
    const start = () => {
      if (active) return;
      active = true;
      window.dispatchEvent(new Event('topics:sidebar-resize-start')); // (1) coalesce fits — all platforms
      if (isTauri) root.classList.add('sidebar-animating'); // (2) skip terminal layout — WebKit only
    };
    const end = () => {
      if (!active) return;
      active = false;
      clearTimeout(safety);
      // Order matters: run the settle fit FIRST, while `.xterm` is still
      // content-visibility:hidden, so the row-DOM rebuild is deferred (cheap); THEN
      // drop the class so the terminals lay out exactly ONCE at the final geometry.
      // Revealing before fitting costs two layouts (reveal + rebuild) — measured ~2x.
      window.dispatchEvent(new Event('topics:sidebar-resize-end'));
      root.classList.remove('sidebar-animating');
    };

    const onRun = (e: TransitionEvent) => {
      if (!isSidebarWidth(e)) return;
      start();
      // If transitionend never arrives (interrupted/cancelled with no event), release
      // after the longest plausible slide so terminals can't stay un-fitted/hidden.
      clearTimeout(safety);
      safety = window.setTimeout(end, 500);
    };
    const onEnd = (e: TransitionEvent) => { if (isSidebarWidth(e)) end(); };

    document.addEventListener('transitionrun', onRun, true);
    document.addEventListener('transitionend', onEnd, true);
    document.addEventListener('transitioncancel', onEnd, true);
    return () => {
      document.removeEventListener('transitionrun', onRun, true);
      document.removeEventListener('transitionend', onEnd, true);
      document.removeEventListener('transitioncancel', onEnd, true);
      clearTimeout(safety);
      end();
    };
  }, []);
}

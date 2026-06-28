import { useEffect } from 'react';

/**
 * Keeps the sidebar collapse/expand smooth while the content does a REAL synchronised
 * push (paddingLeft animates in lockstep with the sidebar's 200ms slide — the content
 * widens as the sidebar leaves). Animating the content width re-flows every mounted xterm
 * each frame; we HOLD the fits for the slide and run exactly ONE at the settled width
 * (`topics:sidebar-resize-start/-end`, the same bracket a divider drag uses), and the
 * canvas renderer (Tauri) keeps the per-frame box relayout cheap.
 *
 * In OVERLAY mode the sidebar animates `transform`, not `width`, so we bracket on either
 * property. A separate event from `pane-resize-*` keeps this off useFloatingVibrancy's
 * frost tracking.
 */
export function useSidebarFitCoalesce(): void {
  useEffect(() => {
    const sidebar = () =>
      document.querySelector<HTMLElement>('[role="navigation"][aria-label="Topics sidebar"]');
    // Overlay mode slides via `transform`; push mode via `width`. Bracket on either.
    const isSidebarSlide = (e: TransitionEvent) =>
      (e.propertyName === 'transform' || e.propertyName === 'width') &&
      e.target instanceof Element && e.target === sidebar();

    let active = false;
    let safety = 0;
    let revealRaf = 0;
    const start = () => {
      if (active) return;
      active = true;
      cancelAnimationFrame(revealRaf); // drop a pending reveal-fit from a rapid prior toggle
      window.dispatchEvent(new Event('topics:sidebar-resize-start')); // hold fits during the slide
    };
    const end = () => {
      if (!active) return;
      active = false;
      clearTimeout(safety);
      // Run exactly one fit() at the settled width on the next frame (the rAF lets the
      // final width paint first — FitAddon measures the rendered glyph cell for columns).
      cancelAnimationFrame(revealRaf);
      revealRaf = requestAnimationFrame(() => window.dispatchEvent(new Event('topics:sidebar-resize-end')));
    };

    const onRun = (e: TransitionEvent) => {
      if (!isSidebarSlide(e)) return;
      start();
      // If transitionend never arrives (interrupted/cancelled with no event), release
      // after the longest plausible slide so terminals can't stay un-fitted.
      clearTimeout(safety);
      safety = window.setTimeout(end, 500);
    };
    const onEnd = (e: TransitionEvent) => { if (isSidebarSlide(e)) end(); };

    document.addEventListener('transitionrun', onRun, true);
    document.addEventListener('transitionend', onEnd, true);
    document.addEventListener('transitioncancel', onEnd, true);
    return () => {
      document.removeEventListener('transitionrun', onRun, true);
      document.removeEventListener('transitionend', onEnd, true);
      document.removeEventListener('transitioncancel', onEnd, true);
      clearTimeout(safety);
      cancelAnimationFrame(revealRaf);
    };
  }, []);
}

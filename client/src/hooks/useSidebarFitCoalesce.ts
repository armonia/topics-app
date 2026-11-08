import { useEffect } from 'react';

/**
 * Coalesces terminal fits across the sidebar collapse/expand so the layout settles with
 * exactly ONE fit, not one per animation frame. The visible push is a compositor FLIP
 * (useSidebarFlipPush) that commits the final paddingLeft in a single reflow — so the slide
 * itself no longer re-flows terminals; this hook brackets `topics:sidebar-resize-start/-end`
 * (the same bracket a divider drag uses) and runs the single settle-fit at the final width.
 * DOM renderer on every host.
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

    let active = false; // a slide is currently animating (dedupes overlapping transitionrun)
    let bracketOpen = false; // we've dispatched -start not yet matched by -end (consumer contract)
    let safety = 0;
    let endRaf = 0;
    // Open the consumer bracket. CRITICAL: keep -start/-end BALANCED across a rapid
    // collapse→expand burst. The previous slide's -end is dispatched on a deferred rAF
    // (so the settled width paints first); if a new slide starts before it fires, we
    // CANCEL that pending -end and stay inside the SAME open bracket rather than emitting
    // a second unmatched -start. Consumers that ref-count the bracket (SingleTerminalPane's
    // resizeDepth, NativeBrowserPlaceholder's freeze) would otherwise stick held forever.
    const openBracket = () => {
      if (endRaf) { cancelAnimationFrame(endRaf); endRaf = 0; } // continuing a burst — keep it open
      if (!bracketOpen) {
        bracketOpen = true;
        window.dispatchEvent(new Event('topics:sidebar-resize-start')); // hold fits during the slide
      }
    };
    // Run exactly one fit() at the settled width on the next frame (the rAF lets the final
    // width paint first — FitAddon measures the rendered glyph cell for columns). If another
    // slide starts before this fires, openBracket() cancels it so one bracket spans the burst.
    const scheduleClose = () => {
      if (endRaf) cancelAnimationFrame(endRaf);
      endRaf = requestAnimationFrame(() => {
        endRaf = 0;
        bracketOpen = false;
        window.dispatchEvent(new Event('topics:sidebar-resize-end'));
      });
    };
    const start = () => {
      if (active) return;
      active = true;
      openBracket();
    };
    const end = () => {
      if (!active) return;
      active = false;
      clearTimeout(safety);
      scheduleClose();
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
      if (endRaf) cancelAnimationFrame(endRaf);
      // Never leave an open bracket behind (would stick a consumer's hold) if we unmount
      // mid-slide before the deferred -end fired.
      if (bracketOpen) { bracketOpen = false; window.dispatchEvent(new Event('topics:sidebar-resize-end')); }
    };
  }, []);
}

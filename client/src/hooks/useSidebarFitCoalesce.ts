import { useEffect, useRef } from 'react';

/**
 * Keeps the sidebar collapse/expand smooth AND lets the content reclaim the freed
 * strip — the REAL push behaviour (content + terminals widen on collapse) — without the
 * per-frame reflow that made it a 352ms freeze.
 *
 * The cost: animating the content width (paddingLeft) re-flows every mounted DOM xterm
 * EVERY frame of the 200ms slide (~200× a full row-grid relayout = the 352ms). The fix
 * is DEFER-RECLAIM: during the slide the sidebar moves via a composited translateX and
 * the content's paddingLeft is left UNCHANGED (zero container resize, ResizeObserver
 * never fires → zero reflow for the whole slide). On transitionend we commit the reclaim
 * in ONE discrete step — flip paddingLeft to its target (a single layout pass, the same
 * ~80ms one-shot the divider-drag RELEASE already costs) — then fire ONE coalesced
 * `fit()` at the settled width. ~200 janky frames → one settle. No blanking, no
 * content-visibility kludge, glass preserved.
 *
 * `commitReclaim` (from App.tsx) flips the committed paddingLeft to the live collapsed
 * state; we also write it directly to #main-content in the same frame so React batching
 * can't leave a 1-frame gap before the fit measures the new width.
 *
 * In OVERLAY mode the sidebar animates `transform`, not `width`, so we bracket on either
 * property. A separate event from `pane-resize-*` keeps this off useFloatingVibrancy's
 * frost tracking.
 */
export function useSidebarFitCoalesce(opts?: { commitReclaim?: () => void }): void {
  const commitRef = useRef(opts?.commitReclaim);
  commitRef.current = opts?.commitReclaim;

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
      // Commit the reclaim NOW (discrete paddingLeft flip = one layout pass), authoritative
      // direct-DOM write so React batching can't delay it past the fit. Then on the NEXT
      // frame run exactly one fit() at the just-settled width (the rAF lets the new width
      // paint first — FitAddon measures the rendered glyph cell to compute columns).
      commitRef.current?.();
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

import { useLayoutEffect, useRef } from 'react';

/**
 * useSidebarFlipPush — make the sidebar collapse/expand PUSH run at 60fps with N live
 * terminals, with NOTHING hidden/held/disabled.
 *
 * THE PROBLEM it replaces: animating `paddingLeft` on #main-content (a LAYOUT property)
 * shrinks the content-box width every frame, which cascades through the PanelGrid/
 * GroupLayout flex cells (`flex: <w> 1 0%`) into every visible `.xterm` box — WebKit
 * relayouts N terminal subtrees ~12×/slide (~25fps with 8). The old code dodged this by
 * SNAPPING the pad instantly when many terminals were visible (manyTerminals) — i.e. it
 * disabled the smooth animation under load, which is exactly what we must not do.
 *
 * THE FIX — FLIP (First / Last / Invert / Play):
 *   1. First  — read the flip layer's current visual left (reflects any in-flight slide).
 *   2. Commit the FINAL paddingLeft on #main-content INSTANTLY (transition:none) → one
 *      synchronous reflow, flex resolves once, terminals lay out at the final width, and
 *      useSidebarFitCoalesce runs its ONE settle-fit. (off the animation timeline.)
 *   3. Last   — read the layer's position at the committed pad.
 *   4. Invert — translateX(First-Last) with transition:none, so it appears unmoved.
 *   5. Play   — next frame, transition translateX → 0 (compositor-only).
 * Every slide frame is then pure GPU composite, O(1) in N. Terminals stay live, visible
 * and interactive throughout; the only relayout is the single committed reflow (same cost
 * as one divider settle).
 *
 * paddingLeft is owned HERE (imperative), NOT a React inline style, so the layout effect
 * can read the OLD position (step 1) before committing the new pad (step 2). The
 * `topics:sidebar-resize-start/-end` bracket the terminals + native browser slidePoll
 * rely on is driven by the SIDEBAR element's own transform transition (useSidebarFitCoalesce)
 * and is left untouched — this hook only owns the content reveal.
 *
 * Interrupt-safe: First is the live rect, so a rapid collapse→expand re-bases from wherever
 * the content currently is rather than jumping.
 */
const SLIDE_MS = 200;

export function useSidebarFlipPush(
  mainContent: React.RefObject<HTMLElement | null>,
  flipLayer: React.RefObject<HTMLElement | null>,
  opts: { collapsed: boolean; expandedPad: number; enabled: boolean },
): void {
  const { collapsed, expandedPad, enabled } = opts;
  const firstRun = useRef(true);
  const cleanupTimer = useRef(0);

  useLayoutEffect(() => {
    const content = mainContent.current;
    const layer = flipLayer.current;
    if (!content || !layer) return;
    window.clearTimeout(cleanupTimer.current);

    // Whole px: the native browser pane is positioned from Math.round(getBoundingClientRect),
    // so a fractional reveal delta would jitter its edge ±1px against the DOM terminals.
    const targetPad = enabled && !collapsed ? Math.round(expandedPad) : 0;

    // (1) First — current visual left of the flip layer (includes any in-flight transform).
    const firstLeft = layer.getBoundingClientRect().left;

    // (2) Commit the final pad + clear any prior transform so Last is the clean layout.
    content.style.paddingLeft = `${targetPad}px`;
    layer.style.transition = 'none';
    layer.style.transform = 'none';

    // No animation on first mount or when the push is disabled (web / non-overlay desktop):
    // just settle at the target pad.
    if (firstRun.current || !enabled) {
      firstRun.current = false;
      layer.style.willChange = '';
      return;
    }

    // (3) Last — position at the committed pad (forces the single reflow).
    const lastLeft = layer.getBoundingClientRect().left;
    const delta = firstLeft - lastLeft;
    if (Math.abs(delta) < 0.5) { layer.style.willChange = ''; return; } // nothing to animate

    // (4) Invert — appear where it visually was (pre-paint; transition is already 'none').
    layer.style.willChange = 'transform';
    layer.style.transform = `translateX(${delta}px)`;
    void layer.getBoundingClientRect(); // flush the inverted transform before arming Play

    // (5) Play — next frame, slide translateX → 0 on the compositor, matching the sidebar's
    // 200ms ease so the content edge stays locked to the sidebar edge.
    requestAnimationFrame(() => {
      const l = flipLayer.current;
      if (!l) return;
      l.style.transition = `transform ${SLIDE_MS}ms ease`;
      l.style.transform = 'translateX(0)';
    });

    // Drop will-change after the slide — never pin a GPU layer (all N terminal canvases)
    // for the whole session (MDN guidance).
    cleanupTimer.current = window.setTimeout(() => {
      const l = flipLayer.current;
      if (l) { l.style.willChange = ''; l.style.transition = ''; }
    }, SLIDE_MS + 60);

    return () => { window.clearTimeout(cleanupTimer.current); };
  }, [collapsed, expandedPad, enabled, mainContent, flipLayer]);
}

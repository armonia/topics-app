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
  const prevCollapsed = useRef(collapsed);
  const cleanupTimer = useRef(0);
  const playRaf = useRef(0);

  useLayoutEffect(() => {
    const content = mainContent.current;
    const layer = flipLayer.current;
    if (!content || !layer) return;
    window.clearTimeout(cleanupTimer.current);
    cancelAnimationFrame(playRaf.current); // drop a prior toggle's pending Play before re-basing

    // Animate ONLY a collapse/expand toggle. A sidebar WIDTH resize changes expandedPad with
    // collapsed unchanged (and lands as one React commit at drag-end, useSidebarAndLayout
    // onUp); that should snap to the new width, not slide 200ms after the handle is released.
    const collapsedToggled = prevCollapsed.current !== collapsed;
    prevCollapsed.current = collapsed;

    // Whole px: the native browser pane is positioned from Math.round(getBoundingClientRect),
    // so a fractional reveal delta would jitter its edge ±1px against the DOM terminals.
    const targetPad = enabled && !collapsed ? Math.round(expandedPad) : 0;

    // (1) First — current visual left of the flip layer (includes any in-flight transform).
    const firstLeft = layer.getBoundingClientRect().left;

    // (2) Commit the final pad + clear any prior transform so Last is the clean layout.
    // Imperative DOM control is this hook's whole purpose (see header): `content`
    // and `layer` are DOM nodes read from the ref args, not the ref objects /
    // props themselves, so react-hooks/immutability mis-targets them here.
    // eslint-disable-next-line react-hooks/immutability
    content.style.paddingLeft = `${targetPad}px`;
    // Stesso motivo della riga sopra: `layer` è un nodo DOM letto dalla ref,
    // non la ref stessa.
    // eslint-disable-next-line react-hooks/immutability
    layer.style.transition = 'none';
    layer.style.transform = 'none';
    // Any width left by a previous slide goes BEFORE measuring Last: measuring a
    // layer that is still wearing the last toggle's extra width gives a delta that
    // is wrong by that amount, and a rapid collapse→expand would accumulate it.
    layer.style.width = '';

    // No animation on first mount, when disabled (web / non-overlay desktop), or for a pure
    // width resize (collapsed unchanged): just settle at the target pad instantly.
    if (firstRun.current || !enabled || !collapsedToggled) {
      firstRun.current = false;
      layer.style.willChange = '';
      return;
    }

    // (3) Last — position at the committed pad (forces the single reflow).
    const lastLeft = layer.getBoundingClientRect().left;
    // Whole px: the native browser pane edge is positioned from Math.round(rect); a fractional
    // invert would shimmer ±1px against the DOM terminals during the slide. Settle is exact
    // (translateX → 0), only the start offset rounds.
    const delta = Math.round(firstLeft - lastLeft);
    if (delta === 0) { layer.style.willChange = ''; return; } // nothing to animate

    // (4) Invert — appear where it visually was (pre-paint; transition is already 'none').
    //
    // AND WIDEN IT BY THE SAME AMOUNT, which is the part that was missing.
    //
    // The layer is a flex child: committing the pad in step (2) SHRINKS it by
    // `expandedPad` before it is shifted. Shifting a narrower box left therefore
    // uncovers a strip on the RIGHT, of exactly the width still to travel — and
    // what shows through is the page background, i.e. the grey band reported on
    // 2026-08-26 ("reopening the sidebar, a grey appears on the right while it
    // closes"). Measured through CDP on the installed Windows build: at +45ms of
    // the reveal the layer was 1000px wide inside a 1400px window with its right
    // edge at 1230 — 170 uncovered pixels, shrinking to 0 as the slide ended.
    //
    // `overflow:hidden` on the parent (see the note at #main-content) clips what
    // OVERFLOWS; it cannot fill what is not painted. Growing the layer by `delta`
    // for the duration of the slide makes its right edge land on the window edge
    // from the first frame: nothing to uncover, and the extra width goes away with
    // the same transition that carries the shift.
    //
    // Only on the reveal (`delta > 0`). On collapse the layer GROWS and its right
    // edge is already at the window edge; adding width there would push content
    // out to be clipped, which is the opposite mistake.
    layer.style.willChange = 'transform';
    layer.style.transform = `translateX(${delta}px)`;
    if (delta > 0) layer.style.width = `calc(100% + ${delta}px)`;
    void layer.getBoundingClientRect(); // flush the inverted transform before arming Play

    // (5) Play — next frame, slide translateX → 0 on the compositor, matching the sidebar's
    // 200ms ease so the content edge stays locked to the sidebar edge.
    playRaf.current = requestAnimationFrame(() => {
      const l = flipLayer.current;
      if (!l) return;
      // `width` rides the same transition as `transform`: the extra width has to
      // disappear exactly as the shift does, or the last frames would go back to
      // uncovering the strip they were added to cover.
      l.style.transition = `transform ${SLIDE_MS}ms ease, width ${SLIDE_MS}ms ease`;
      l.style.transform = 'translateX(0)';
      l.style.width = '';
    });

    // Drop will-change after the slide — never pin a GPU layer (all N terminal canvases)
    // for the whole session (MDN guidance).
    cleanupTimer.current = window.setTimeout(() => {
      const l = flipLayer.current;
      // `width` cleared here too: an inline width left behind would pin the layer
      // for the rest of the session, and the next window resize would find it
      // stuck at a size that no longer means anything.
      if (l) { l.style.willChange = ''; l.style.transition = ''; l.style.width = ''; }
    }, SLIDE_MS + 60);

    return () => { window.clearTimeout(cleanupTimer.current); cancelAnimationFrame(playRaf.current); };
  }, [collapsed, expandedPad, enabled, mainContent, flipLayer]);
}

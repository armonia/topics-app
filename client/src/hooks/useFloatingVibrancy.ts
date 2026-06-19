import { useEffect } from 'react';

/**
 * Drives the native per-region vibrancy addon (macOS, Electron).
 *
 * The Electron window is transparent when the addon is available, so the frosted
 * "glass" is painted by native NSVisualEffectViews placed under specific rects:
 *  - floating-splits ON  → one region per top-level panel (+ the sidebar), so the
 *    GAPS between panels stay transparent and reveal the clear live desktop.
 *  - floating-splits OFF → a single full-window region, so the whole chrome
 *    frosts exactly like the old whole-window vibrancy (no see-through).
 *
 * Latency contract (mirrors the native browser panes): we push rects only on a
 * SETTLED layout (rAF-coalesced) and FREEZE during drag/resize gestures — a
 * JS→IPC→native setFrame loop can't track a 60fps gesture, so we let the frost
 * hold its last position and snap to the final rects on gesture end.
 *
 * Fully inert when not in Electron or when the addon isn't available (main
 * no-ops): on those paths the window keeps whole-window vibrancy / CSS fallback.
 */
const FLOAT_RADIUS = 10; // keep in sync with --float-radius in index.css

type VibrancyApi = {
  setRegions: (rects: Array<{ x: number; y: number; w: number; h: number; radius?: number }>) => void;
  clear: () => void;
};

export function useFloatingVibrancy(isElectron: boolean, floatingSplits: boolean) {
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { vibrancy?: VibrancyApi } }).electronAPI?.vibrancy;
    if (!isElectron || !api) return;

    let frozen = false;
    let rafId = 0;
    let lastKey = '';

    const collect = (): Array<{ x: number; y: number; w: number; h: number; radius: number }> => {
      if (!floatingSplits) {
        // One full-window region → frost the whole chrome (vibrancy parity).
        return [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, radius: 0 }];
      }
      // Top-level panels only (skip cards nested inside a project panel) + sidebar.
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-split-card]'))
        .filter((el) => !(el.parentElement && el.parentElement.closest('[data-split-card]')));
      const sidebar = document.querySelector<HTMLElement>('[role="navigation"][aria-label="Topics sidebar"]');
      const els = sidebar ? [sidebar, ...cards] : cards;
      return els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), radius: FLOAT_RADIUS };
        })
        .filter((r) => r.w > 1 && r.h > 1);
    };

    const push = () => {
      if (frozen) return;
      const rects = collect();
      const key = JSON.stringify(rects);
      if (key === lastKey) return; // dedupe — don't spam IPC when nothing moved
      lastKey = key;
      api.setRegions(rects);
    };
    const schedule = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(push);
    };

    // Divider resize: the panes resize live (direct DOM width mutation), so we
    // TRACK the frost live too — a per-frame loop re-reads the panel rects and
    // repositions the native views so the glass follows the split as you drag
    // (the "live preview"). Resize is a constrained 1-axis move, so the native
    // setFrame keeps up well enough; on end we snap to the settled rects.
    let liveRaf = 0;
    const liveLoop = () => {
      const rects = collect();
      const key = JSON.stringify(rects);
      if (key !== lastKey) { lastKey = key; api.setRegions(rects); }
      liveRaf = requestAnimationFrame(liveLoop);
    };
    const startLive = () => { frozen = true; cancelAnimationFrame(liveRaf); liveRaf = requestAnimationFrame(liveLoop); };
    const stopLive = () => { cancelAnimationFrame(liveRaf); liveRaf = 0; frozen = false; lastKey = ''; schedule(); };

    // Free-form tab drag is bigger/laggier than a divider drag — freeze it (the
    // frost holds, then snaps on drop) rather than chase it frame-by-frame.
    const freeze = () => { frozen = true; };
    const unfreeze = () => { frozen = false; lastKey = ''; setTimeout(schedule, 60); };

    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

    window.addEventListener('resize', schedule);
    window.addEventListener('topics:pane-resize-start', startLive);
    window.addEventListener('topics:pane-resize-end', stopLive);
    document.addEventListener('dragstart', freeze, true);
    document.addEventListener('dragend', unfreeze, true);
    document.addEventListener('drop', unfreeze, true);
    // Safety net for layout changes no observer caught (e.g. native-pane reflow).
    const poll = window.setInterval(schedule, 700);

    schedule();

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('topics:pane-resize-start', startLive);
      window.removeEventListener('topics:pane-resize-end', stopLive);
      document.removeEventListener('dragstart', freeze, true);
      document.removeEventListener('dragend', unfreeze, true);
      document.removeEventListener('drop', unfreeze, true);
      window.clearInterval(poll);
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(liveRaf);
      api.clear();
    };
  }, [isElectron, floatingSplits]);
}

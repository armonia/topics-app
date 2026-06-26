import { useEffect } from 'react';
import { isElectron, isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';

/**
 * Drives native per-region vibrancy on macOS — Electron AND Tauri.
 *
 * The desktop window is transparent, so the frosted "glass" is painted by native
 * NSVisualEffectViews placed under specific rects (Electron: the `native/vibrancy`
 * addon via `electronAPI.vibrancy`; Tauri: the `vibrancy_set_regions` command in
 * src-tauri/src/lib.rs — one NSVisualEffectView per rect, inserted below the
 * transparent webview). Same rect-stream, two backends:
 *  - floating-splits ON  → one region per top-level panel (+ the sidebar), so the
 *    GAPS between panels stay transparent and reveal the clear live desktop.
 *  - floating-splits OFF → a single full-window region, so the whole chrome
 *    frosts exactly like whole-window vibrancy (no see-through).
 *
 * Latency contract (mirrors the native browser panes): we push rects only on a
 * SETTLED layout (rAF-coalesced) and FREEZE during drag/resize gestures — a
 * JS→native setFrame loop can't track a 60fps gesture, so we let the frost hold
 * its last position and snap to the final rects on gesture end.
 *
 * Fully inert off macOS / on web (the resolver returns null → the effect bails),
 * where the window keeps its CSS fallback.
 */
const FLOAT_RADIUS = 10; // keep in sync with --float-radius in index.css

type Rect = { x: number; y: number; w: number; h: number; radius?: number };
type VibrancyApi = {
  setRegions: (rects: Rect[]) => void;
  clear: () => void;
};

/** Resolve the host's per-region vibrancy driver, or null where there's none
 *  (web, non-mac). Under Tauri we detect macOS DIRECTLY (isTauri + userAgent)
 *  rather than trusting the `.tauri-mac` html class — that class is set by the
 *  pre-paint inline script, whose Tauri detection can miss (internals not yet
 *  injected at <head> time), and a missed class silently kills the whole frost.
 *  Detecting here makes the hook self-sufficient and re-asserts the transparency
 *  classes the CSS needs so the native frost behind the (clear) webview shows. */
function resolveVibrancy(): VibrancyApi | null {
  if (isElectron) {
    const api = (window as unknown as { electronAPI?: { vibrancy?: VibrancyApi } }).electronAPI?.vibrancy;
    return api ?? null;
  }
  const isMac = typeof navigator !== 'undefined'
    && (/Mac/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''));
  if (isTauri && isMac) {
    if (typeof document !== 'undefined') {
      // Idempotent safety net: the page bg is opaque without `.electron-mac`, which
      // would hide the frost even when we DO place the NSVisualEffectViews.
      document.documentElement.classList.add('electron-mac', 'tauri-mac');
    }
    return {
      setRegions: (rects) => {
        void tauriInvoke('vibrancy_set_regions', {
          regions: rects.map((r, i) => ({ id: `r${i}`, x: r.x, y: r.y, width: r.w, height: r.h, radius: r.radius ?? 0 })),
        }).catch(() => {});
      },
      clear: () => {
        void tauriInvoke('vibrancy_set_regions', { regions: [] }).catch(() => {});
      },
    };
  }
  return null;
}

export function useFloatingVibrancy(floatingSplits: boolean) {
  useEffect(() => {
    const api = resolveVibrancy();
    if (!api) return;

    let frozen = false;
    let lastKey = '';

    const topLevelCards = (): HTMLElement[] =>
      // Top-level panels only (skip cards nested inside a project panel).
      Array.from(document.querySelectorAll<HTMLElement>('[data-split-card]'))
        .filter((el) => !(el.parentElement && el.parentElement.closest('[data-split-card]')));
    const sidebarEl = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[role="navigation"][aria-label="Topics sidebar"]');

    const collect = (): Array<{ x: number; y: number; w: number; h: number; radius: number }> => {
      if (!floatingSplits) {
        // One full-window region → frost the whole chrome (vibrancy parity).
        return [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, radius: 0 }];
      }
      const cards = topLevelCards();
      const sidebar = sidebarEl();
      const els = sidebar ? [sidebar, ...cards] : cards;
      return els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), radius: FLOAT_RADIUS };
        })
        .filter((r) => r.w > 1 && r.h > 1);
    };

    // Re-point the ResizeObserver at the CURRENT top-level cards + sidebar. A
    // RO fires precisely when one of those boxes changes size (divider settle,
    // sidebar collapse, window resize) — so we no longer need to watch attribute
    // mutations across the whole tree to notice geometry changes.
    const ro = new ResizeObserver(() => schedule());
    let observed: Element[] = [];
    const retarget = () => {
      const sidebar = sidebarEl();
      const next: Element[] = [document.body, ...(sidebar ? [sidebar] : []), ...topLevelCards()];
      if (next.length === observed.length && next.every((el, i) => el === observed[i])) return;
      ro.disconnect();
      next.forEach((el) => ro.observe(el));
      observed = next;
    };

    const push = () => {
      if (frozen) return;
      retarget();
      const rects = collect();
      const key = JSON.stringify(rects);
      if (key === lastKey) return; // dedupe — don't spam IPC when nothing moved
      lastKey = key;
      api.setRegions(rects);
    };

    // Coalesce every passive layout signal into AT MOST one collect() per FRAME.
    // rAF (not setTimeout): a deferred timer is throttled/suspended by WebKit when
    // the webview is backgrounded AND trails the layout by its delay — so a window
    // resize, sidebar toggle or any non-gesture reflow only caught the OLD 120ms
    // debounce visibly LAGGED the vibrancy behind the moving layout ("quando
    // resizo non segue"). rAF fires the next paint frame when visible and reads
    // rects post-layout, so the frost tracks per frame. This does NOT reintroduce
    // the old per-mutation storm: the trigger is the ResizeObserver, which is
    // SILENT unless an observed box actually changes size (streaming terminals /
    // chat mutate content, not box size), so the loop only spins during real
    // resizes — exactly when we want per-frame tracking.
    let settle = 0;
    const schedule = () => {
      if (frozen || settle) return; // already pending → coalesce, do no work
      settle = requestAnimationFrame(() => { settle = 0; push(); });
    };
    // Bypass the debounce for end-of-gesture snaps so the frost lands instantly.
    const flush = () => { if (settle) { cancelAnimationFrame(settle); settle = 0; } push(); };

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
    const stopLive = () => { cancelAnimationFrame(liveRaf); liveRaf = 0; frozen = false; lastKey = ''; flush(); };

    // Free-form tab drag is bigger/laggier than a divider drag — freeze it (the
    // frost holds, then snaps on drop) rather than chase it frame-by-frame.
    const freeze = () => { frozen = true; };
    const unfreeze = () => { frozen = false; lastKey = ''; setTimeout(flush, 60); };

    // No MutationObserver: observing body's subtree (even childList-only) forces
    // the engine to QUEUE a MutationRecord for every node a streaming terminal
    // adds/removes — thousands per second — which costs real main-thread time
    // regardless of how cheap our callback is. We don't need it: when a top-level
    // card is opened/closed its siblings reflow to make room, so the per-card
    // ResizeObserver already fires and `push()` re-targets onto the new set. The
    // 700ms safety poll below backstops any structural change that resized nothing.
    retarget();

    window.addEventListener('resize', schedule);
    window.addEventListener('topics:pane-resize-start', startLive);
    window.addEventListener('topics:pane-resize-end', stopLive);
    document.addEventListener('dragstart', freeze, true);
    document.addEventListener('dragend', unfreeze, true);
    document.addEventListener('drop', unfreeze, true);

    // Sidebar collapse/expand animates `width` over 200ms (.sidebar-transition).
    // The debounced push lags the moving layout, so the frost trails the sidebar
    // and a stale grey edge lingers next to it ("non segue i bg / si disallinea /
    // doppio bordo"). Track it LIVE for the animation's duration — exactly like a
    // divider drag — then settle on transitionend. Scoped to the sidebar's width
    // transition so unrelated CSS transitions don't spin the rAF loop.
    const isSidebarWidth = (e: TransitionEvent) =>
      e.propertyName === 'width' && e.target instanceof Element && e.target === sidebarEl();
    const onSidebarTransitionRun = (e: TransitionEvent) => { if (isSidebarWidth(e)) startLive(); };
    const onSidebarTransitionEnd = (e: TransitionEvent) => { if (isSidebarWidth(e)) stopLive(); };
    document.addEventListener('transitionrun', onSidebarTransitionRun, true);
    document.addEventListener('transitionend', onSidebarTransitionEnd, true);
    document.addEventListener('transitioncancel', onSidebarTransitionEnd, true);

    // Safety net for layout changes no observer caught (e.g. native-pane reflow).
    const poll = window.setInterval(schedule, 700);

    // Paint the FIRST frame synchronously rather than through the debounce timer.
    // A deferred setTimeout can be suspended while the webview is occluded (WebKit
    // throttles background timers), which would leave the chrome unfrosted until
    // the next layout signal — the "vibrancy missing at launch" bug. A synchronous
    // push lands the initial regions immediately; schedule() then coalesces updates.
    push();

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('topics:pane-resize-start', startLive);
      window.removeEventListener('topics:pane-resize-end', stopLive);
      document.removeEventListener('dragstart', freeze, true);
      document.removeEventListener('dragend', unfreeze, true);
      document.removeEventListener('drop', unfreeze, true);
      document.removeEventListener('transitionrun', onSidebarTransitionRun, true);
      document.removeEventListener('transitionend', onSidebarTransitionEnd, true);
      document.removeEventListener('transitioncancel', onSidebarTransitionEnd, true);
      window.clearInterval(poll);
      if (settle) cancelAnimationFrame(settle);
      cancelAnimationFrame(liveRaf);
      api.clear();
    };
  }, [isElectron, floatingSplits]);
}

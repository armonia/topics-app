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
type Timing = [number, number, number, number];
type VibrancyApi = {
  setRegions: (rects: Rect[]) => void;
  clear: () => void;
  // Tauri+mac only: hand a FIXED, known animation (the sidebar width transition) to
  // AppKit's animator in ONE IPC, so the frost rides the same Core Animation /
  // WindowServer clock as the CSS transition — no per-frame rAF→IPC, no stepping.
  animateRegions?: (rects: Rect[], durationMs: number, timing: Timing) => void;
};

// CSS easing keyword → cubic-bezier control points (so the native CAMediaTimingFunction
// matches the CSS curve exactly). getComputedStyle may already return the bezier form.
const EASE_KEYWORDS: Record<string, Timing> = {
  ease: [0.25, 0.1, 0.25, 1], linear: [0, 0, 1, 1],
  'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
};

/** Read the element's `width` transition duration + timing curve straight from CSS
 *  (the single source of truth), or null if there's no parseable width transition. */
function readWidthTiming(el: HTMLElement): { durationMs: number; timing: Timing } | null {
  const cs = getComputedStyle(el);
  const props = cs.transitionProperty.split(',').map((s) => s.trim());
  let idx = props.indexOf('width');
  if (idx < 0) idx = props.indexOf('all');
  if (idx < 0) return null;
  const durs = cs.transitionDuration.split(',').map((s) => s.trim());
  // Don't split timing-functions inside cubic-bezier(...)'s own commas.
  const fns = cs.transitionTimingFunction.split(/,(?![^(]*\))/).map((s) => s.trim());
  const durStr = durs[idx] ?? durs[0] ?? '';
  const fnStr = fns[idx] ?? fns[0] ?? '';
  const durationMs = parseFloat(durStr) * (durStr.trim().endsWith('ms') ? 1 : 1000);
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  let timing: Timing | null = EASE_KEYWORDS[fnStr] ?? null;
  const m = fnStr.match(/cubic-bezier\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map(Number) as Timing;
    if (p.length === 4 && p.every((n) => Number.isFinite(n))) timing = p;
  }
  return timing ? { durationMs, timing } : null;
}

/** Predict the END rect set of a sidebar width toggle analytically from the START
 *  rects + the target sidebar width — NO DOM mutation, NO forced reflow. collect()
 *  yields [sidebar, ...cards]; the sidebar is the leftmost box and the content area
 *  is winW - sidebarWidth, so the cards scale around the content origin. Exact for
 *  the sidebar + single-card case; the transitionend settle push pins exact pixels. */
function predictSidebarEnd(start: Rect[], sbStartW: number, sbTargetW: number): Rect[] {
  const winW = window.innerWidth;
  const cw0 = winW - sbStartW;
  const cw1 = winW - sbTargetW;
  const s = cw0 > 0 ? cw1 / cw0 : 1;
  return start.map((r, i) => i === 0
    ? { ...r, w: Math.round(sbTargetW) }
    : { ...r, x: Math.round(sbTargetW + (r.x - sbStartW) * s), w: Math.round(r.w * s) });
}

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
      animateRegions: (rects, durationMs, timing) => {
        void tauriInvoke('vibrancy_animate_regions', {
          regions: rects.map((r, i) => ({ id: `r${i}`, x: r.x, y: r.y, width: r.w, height: r.h, radius: r.radius ?? 0 })),
          durationMs, timing,
        }).catch(() => {});
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
      const toRect = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), radius: FLOAT_RADIUS };
      };
      const cards = topLevelCards().map(toRect).filter((r) => r.w > 1 && r.h > 1);
      // ALWAYS include the sidebar region (even collapsed → w≈0), so the region SET
      // and its id (r0) stay STABLE across collapse↔expand. The native sidebar
      // animation maps views by id; if a collapsed sidebar dropped out of the set,
      // every id would shift and the expand animation would fly the wrong views into
      // the sidebar slot. A w=0 region is an invisible native view — harmless at rest.
      const sb = sidebarEl();
      const sbRect = sb ? toRect(sb) : null;
      return sbRect && sbRect.h > 1 ? [sbRect, ...cards] : cards;
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

    // Coalesce passive layout signals into AT MOST one collect() per SETTLE_MS.
    // setTimeout (not rAF) for this generic path: a requested rAF that never fires
    // because the webview is occluded would leave `settle` non-zero forever and
    // wedge every future schedule() (the `if (settle) return` guard) — observed as
    // the frost going blank and never recovering. setTimeout always fires when the
    // view is visible, so the path self-heals. Smooth tracking of an ACTIVE gesture
    // (divider / sidebar / window resize) is handled by the live rAF loops below,
    // which are bounded by explicit start/stop and can't get stuck.
    const SETTLE_MS = 90;
    let settle = 0;
    const schedule = () => {
      if (frozen || settle) return; // already pending → coalesce, do no work
      settle = window.setTimeout(() => { settle = 0; push(); }, SETTLE_MS);
    };
    // Bypass the debounce for end-of-gesture snaps so the frost lands instantly.
    const flush = () => { if (settle) { clearTimeout(settle); settle = 0; } push(); };

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
    // DOM drags (divider / sidebar collapse) resize panes WITHOUT resizing the OS
    // window, so they run in the DEFAULT runloop mode where the JS→IPC push drains
    // promptly — re-read the rects and reposition the per-region views every frame
    // for a live "frosted cards follow the split" preview, snapping on end. (The
    // WINDOW-edge case is handled natively in Rust — reflow_vibrancy_regions — since
    // its IPC path is starved by AppKit's event-tracking runloop.)
    const startLive = () => { frozen = true; cancelAnimationFrame(liveRaf); liveRaf = requestAnimationFrame(liveLoop); };
    const stopLive = () => { cancelAnimationFrame(liveRaf); liveRaf = 0; frozen = false; lastKey = ''; flush(); };

    // Sidebar toggle = a FIXED 200ms CSS width transition. Instead of chasing it with
    // the rAF→IPC loop (which lands ~5 discrete, IPC-jittered steps), hand the whole
    // move to AppKit's animator in ONE IPC: read the curve from CSS, predict the END
    // rects analytically, and let Core Animation interpolate the frost on the SAME
    // clock as the CSS transition (continuous, no stepping). Falls back to startLive()
    // on Electron / non-floating / any unparseable input — zero regression. The
    // transitionend handler keeps calling stopLive(), which flush()es pixel-exact
    // final rects (correcting any sub-px prediction drift).
    const beginSidebarFrostAnimation = () => {
      const el = sidebarEl();
      if (!floatingSplits || !api.animateRegions || !el) { startLive(); return; }
      const sbTargetW = parseFloat(el.style.width); // React set inline width = target at transitionrun
      const t = readWidthTiming(el);
      const startRects = collect();
      const sb = startRects[0]; // collect() always yields the sidebar first (even collapsed)
      if (!Number.isFinite(sbTargetW) || !t || !sb) { startLive(); return; }
      const end = predictSidebarEnd(startRects, sb.w, sbTargetW);
      frozen = true; // suspend settle/poll/RO pushes for the duration of the native anim
      if (settle) { clearTimeout(settle); settle = 0; }
      lastKey = JSON.stringify(end); // so the end-of-toggle flush only re-pushes if pixels differ
      api.animateRegions(end, t.durationMs, t.timing);
    };

    // Free-form tab drag is bigger/laggier than a divider drag — freeze it (the
    // frost holds, then snaps on drop) rather than chase it frame-by-frame.
    const freeze = () => { frozen = true; };
    const unfreeze = () => { frozen = false; lastKey = ''; setTimeout(flush, 60); };

    // Window resize SETTLE: during the live drag the frost is tracked natively in
    // Rust (reflow_vibrancy_regions, driven by AppKit) since the JS→IPC path is
    // starved by the event-tracking runloop. This 'resize' → schedule only needs to
    // push the pixel-correct rects (widths the native reflow left stale) once the
    // drag ends and the runloop returns to default mode, where setTimeout fires.

    // No MutationObserver: observing body's subtree (even childList-only) forces
    // the engine to QUEUE a MutationRecord for every node a streaming terminal
    // adds/removes — thousands per second — which costs real main-thread time
    // regardless of how cheap our callback is. We don't need it: when a top-level
    // card is opened/closed its siblings reflow to make room, so the per-card
    // ResizeObserver already fires and `push()` re-targets onto the new set. The
    // 700ms safety poll below backstops any structural change that resized nothing.
    retarget();

    // Force a NON-deduped reconcile on window resize and on tab/tray re-show. A
    // spurious *same-size* native Resized (tray re-show, Space/display switch) yields
    // identical rects, so the lastKey dedupe (below) would skip the settle push that
    // tears down any stranded full-window frost cover — leaving panes "tutte grigie".
    // Resetting lastKey defeats that dedupe so the push always reaches native, whose
    // apply_vibrancy_regions unconditionally removes the cover. Belt-and-suspenders to
    // the native fix in vibrancy_resize_cover (which stops the cover being raised here
    // at all).
    const forceReconcile = () => { lastKey = ''; schedule(); };
    const onVisible = () => { if (!document.hidden) forceReconcile(); };
    window.addEventListener('resize', forceReconcile);
    document.addEventListener('visibilitychange', onVisible);
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
    const onSidebarTransitionRun = (e: TransitionEvent) => { if (isSidebarWidth(e)) beginSidebarFrostAnimation(); };
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
      window.removeEventListener('resize', forceReconcile);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('topics:pane-resize-start', startLive);
      window.removeEventListener('topics:pane-resize-end', stopLive);
      document.removeEventListener('dragstart', freeze, true);
      document.removeEventListener('dragend', unfreeze, true);
      document.removeEventListener('drop', unfreeze, true);
      document.removeEventListener('transitionrun', onSidebarTransitionRun, true);
      document.removeEventListener('transitionend', onSidebarTransitionEnd, true);
      document.removeEventListener('transitioncancel', onSidebarTransitionEnd, true);
      window.clearInterval(poll);
      if (settle) clearTimeout(settle);
      cancelAnimationFrame(liveRaf);
      api.clear();
    };
  }, [isElectron, floatingSplits]);
}

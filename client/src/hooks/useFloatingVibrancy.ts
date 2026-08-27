import { useEffect } from 'react';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';
import { isWindowAwake } from '../state/windowAwake';

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
 *
 * WINDOWS IS A DELIBERATE NON-CLIENT of this hook. The acrylic build still gets
 * the frost, but from ONE whole-window DWM backdrop, so there are no regions to
 * push and the IPC above is never called there. The hook's only job on Windows
 * is the class safety net in `assertFrostClasses`. Consequence, and it is the
 * contract rather than a defect: Windows gets frosted chrome and frosted GAPS
 * between the cards, never gaps you can see the live desktop through.
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

/** Read a CSS transition's duration + timing curve for `prop` straight from CSS
 *  (the single source of truth), or null if there's no parseable transition for it. */
function readTiming(el: HTMLElement, prop: string): { durationMs: number; timing: Timing } | null {
  const cs = getComputedStyle(el);
  const props = cs.transitionProperty.split(',').map((s) => s.trim());
  let idx = props.indexOf(prop);
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

const isMacHost = (): boolean => typeof navigator !== 'undefined'
  && (/Mac/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''));
/** Windows: WebView2 always carries "Windows NT" in the userAgent. Same
 *  OR-with-platform defence as the mac probe (platform is deprecated and can
 *  come back empty). */
const isWindowsHost = (): boolean => typeof navigator !== 'undefined'
  && (/Win/i.test(navigator.platform || '') || /Windows NT/i.test(navigator.userAgent || ''));

/** Re-assert the html classes the frost CSS needs, on BOTH desktop platforms.
 *
 *  This is a safety net, not the primary path: `client/public/boot.js` sets
 *  them pre-paint, but its Tauri detection can miss (the internals are not
 *  guaranteed to be injected at <head> time), and a missed class does not fail
 *  loudly. It silently leaves the page painting an OPAQUE background over a
 *  native backdrop that is working perfectly, which reads as "the acrylic /
 *  vibrancy is broken". Adding a class that is already there costs nothing, so
 *  the net runs unconditionally.
 *
 *  `native-frost` is the shell-neutral hook carrying every translucency rule;
 *  the per-OS class next to it gates only what is OS-specific (see index.css). */
function assertFrostClasses(): void {
  if (!isTauri || typeof document === 'undefined') return;
  if (isMacHost()) document.documentElement.classList.add('electron-mac', 'tauri-mac', 'native-frost');
  else if (isWindowsHost()) document.documentElement.classList.add('windows-acrylic', 'native-frost');
}

/** Resolve the host's PER-REGION vibrancy driver, or null where there is none.
 *
 *  Null off macOS, and Windows is a deliberate null rather than an omission:
 *  DWM backdrops are whole-window and have no per-region equivalent, so
 *  `vibrancy_set_regions` / `vibrancy_animate_regions` must never be called
 *  there. Windows still gets the classes above, so it gets frosted chrome and
 *  frosted gaps between the cards. What it cannot get is TRANSPARENT gaps
 *  showing the live desktop: that is the macOS-only half of this feature.
 *
 *  macOS is detected DIRECTLY (isTauri + userAgent) rather than by reading the
 *  `.tauri-mac` class back, for the same reason the safety net exists: the
 *  class may be missing, and driving native views off a missing class would
 *  make the hook inert exactly when it is needed. */
function resolveVibrancy(): VibrancyApi | null {
  assertFrostClasses();
  if (isTauri && isMacHost()) {
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
    // Il loop vivo non aveva NESSUNA condizione di stop interna: si fermava solo
    // se arrivava l'evento di fine. Se quell'evento si perdeva — un
    // `transitionend` mangiato, un drag finito fuori dalla finestra — girava per
    // sempre, chiamando `collect()` (N `getBoundingClientRect`) a ogni frame.
    // Nel profilo del 2026-07-28 è uno dei sospetti per i 98 campioni in
    // `serviceRequestAnimationFrameCallbacks` con l'app FERMA.
    //
    // Il freno non è una scadenza fissa (un drag lungo è legittimo e non va
    // troncato): è "le rect non si muovono più da un po'". Durante un
    // trascinamento vero cambiano a ogni frame e il loop non si ferma mai.
    const LIVE_IDLE_STOP_MS = 1500;
    let lastChangeAt = 0;
    const liveLoop = (ts: number) => {
      const rects = collect();
      const key = JSON.stringify(rects);
      if (key !== lastKey) { lastKey = key; api.setRegions(rects); lastChangeAt = ts; }
      else if (lastChangeAt && ts - lastChangeAt > LIVE_IDLE_STOP_MS) { stopLive(); return; }
      liveRaf = requestAnimationFrame(liveLoop);
    };
    // DOM drags (divider / sidebar collapse) resize panes WITHOUT resizing the OS
    // window, so they run in the DEFAULT runloop mode where the JS→IPC push drains
    // promptly — re-read the rects and reposition the per-region views every frame
    // for a live "frosted cards follow the split" preview, snapping on end. (The
    // WINDOW-edge case is handled natively in Rust — reflow_vibrancy_regions — since
    // its IPC path is starved by AppKit's event-tracking runloop.)
    const startLive = () => { frozen = true; cancelAnimationFrame(liveRaf); lastChangeAt = 0; liveRaf = requestAnimationFrame(liveLoop); };
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
      // The desktop sidebar collapses via a composited translateX(0 ↔ -100%) over
      // a `transform` transition (CONSTANT width), NOT a width change — so read the
      // TRANSFORM timing and model the slide. (The old width path never fired: no
      // width transition runs, so the frost fell to the 90ms debounce and trailed.)
      const t = readTiming(el, 'transform');
      // Base = the SETTLED resting regions we last pushed (clean, pre-toggle, no
      // in-flight transform). collect() here would read mid-flip transformed rects.
      let base: Rect[] = [];
      try { base = JSON.parse(lastKey || '[]') as Rect[]; } catch { /* keep [] */ }
      const sb = base[0]; // collect() always yields the sidebar first
      if (!t || !sb || !Number.isFinite(sb.w) || sb.w <= 0) { startLive(); return; }
      const collapsing = /translateX\(\s*-100%/.test(el.style.transform || '');
      const W = sb.w;
      // The content area reclaims (collapse) / yields (expand) the sidebar's width,
      // so the CARDS scale exactly like a width toggle (sidebar W↔0) — reuse the
      // width-scale predictor for them. The SIDEBAR itself doesn't shrink; it
      // slides: collapsed → x=-W (off-screen), expanded → x=0.
      const [sbStartW, sbTargetW] = collapsing ? [W, 0] : [0, W];
      const end = predictSidebarEnd(base, sbStartW, sbTargetW);
      end[0] = { ...sb, x: collapsing ? -Math.round(W) : 0, w: Math.round(W) };
      frozen = true; // suspend settle/poll/RO pushes for the native anim's duration
      if (settle) { clearTimeout(settle); settle = 0; }
      lastKey = JSON.stringify(end); // end-of-toggle flush only re-pushes if pixels differ
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
    // The desktop sidebar collapse/expand is a `transform` (translateX) slide.
    // Match ONLY that on the sidebar element: a `width` transition now means a
    // sidebar RESIZE (constant-width collapse doesn't touch width), which must
    // snap via the generic settle, NOT run the collapse slide animation.
    // In CAPTURE su document: questo scatta per OGNI transizione CSS dell'app —
    // ogni hover, ogni popover, ogni tab che si evidenzia. Prima ognuna di quelle
    // chiamava `sidebarEl()`, cioè un `querySelector` sull'intero documento, per
    // poi scoprire quasi sempre che no, non era la sidebar. Adesso il predicato
    // legge gli attributi del BERSAGLIO dell'evento: stesso selettore, ma senza
    // interrogare il documento.
    const isSidebarSlide = (e: TransitionEvent) =>
      e.propertyName === 'transform' &&
      e.target instanceof Element &&
      e.target.getAttribute('role') === 'navigation' &&
      e.target.getAttribute('aria-label') === 'Topics sidebar';
    const onSidebarTransitionRun = (e: TransitionEvent) => { if (isSidebarSlide(e)) beginSidebarFrostAnimation(); };
    const onSidebarTransitionEnd = (e: TransitionEvent) => { if (isSidebarSlide(e)) stopLive(); };
    document.addEventListener('transitionrun', onSidebarTransitionRun, true);
    document.addEventListener('transitionend', onSidebarTransitionEnd, true);
    document.addEventListener('transitioncancel', onSidebarTransitionEnd, true);

    // Rete di sicurezza per i cambi di layout che nessun observer ha visto (es.
    // reflow di una pane nativa). Ogni giro fa `retarget()` (due
    // `querySelectorAll`) e `collect()` (un `getBoundingClientRect` per card):
    // un layout sincrono forzato ~1,4 volte al secondo, per sempre.
    //
    // Con la finestra dietro un'altra app quel lavoro non compra niente: la
    // vibrancy è ciò che si vede attraverso il vetro di una finestra che nessuno
    // sta guardando. Al ritorno del fuoco si riconcilia comunque (`onFocus` qui
    // sotto), quindi saltare i giri non lascia il vetro stantìo.
    const poll = window.setInterval(() => { if (isWindowAwake()) schedule(); }, 700);
    // Il ritorno a fuoco riallinea subito, senza aspettare il prossimo giro.
    const onFocus = () => forceReconcile();
    window.addEventListener('focus', onFocus);

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
      window.removeEventListener('focus', onFocus);
      window.clearInterval(poll);
      if (settle) clearTimeout(settle);
      cancelAnimationFrame(liveRaf);
      api.clear();
    };
  }, [floatingSplits]);
}

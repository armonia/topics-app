/**
 * Phase 30.1 BROWSER-CHAT-06 — Placeholder for native WebContentsView.
 *
 * The actual web content is rendered by Electron OUTSIDE the React DOM
 * tree (it's an OS-native window child of mainWindow.contentView). This
 * component is a layout-anchored div whose getBoundingClientRect()
 * drives WebContentsView placement via setBounds.
 *
 * On agent_active: hide the WebContentsView by calling setBounds({0,0,0,0})
 * and render a React overlay over the now-empty placeholder. When the
 * agent finishes, the ResizeObserver fires again and restores bounds.
 *
 * Why setBounds for hide (not setVisible): Electron's WebContentsView API
 * does NOT expose setVisible. setBounds with zero dimensions is the
 * documented hide pattern (verified via context7 + Electron docs).
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { NativeBrowserHandle } from '../../hooks/useNativeBrowser';

/** Inset (px) of each native WebContentsView vs its placeholder. 0 = the page
 *  fills the pane edge-to-edge (no visible "padding" frame), so the browser
 *  integrates seamlessly into the UI. Resize dividers stay reachable from the
 *  ADJACENT pane's grab zone (DOM dividers extend ±15px into the neighbour, and
 *  a resize hides the view on `topics:pane-resize-start`); only a divider
 *  between TWO native browser panes loses its grab strip — re-introduce a small
 *  inset here if that combination needs it. */
const NATIVE_VIEW_GUTTER = 0;

interface NativeBrowserPlaceholderProps {
  browser: NativeBrowserHandle;
  /** Whether the parent pane is currently visible. Defaults to true so
   *  legacy callers behave unchanged. When false, force the WebContentsView
   *  to zero bounds — `display:none` on a React ancestor doesn't reliably
   *  fire ResizeObserver, so the OS-level overlay would otherwise stay at
   *  its last-known rect and bleed through underneath the active pane in
   *  a keep-alive ladder. */
  isVisible?: boolean;
}

export function NativeBrowserPlaceholder({ browser, isVisible = true }: NativeBrowserPlaceholderProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  // Phase 30.1 polish — global DnD state. WebContentsView is OS-level
  // and covers React DOM, so during a drag-and-drop the drop preview
  // overlay (drag image, drop indicator, ghost) gets clipped behind
  // the browser. We hide the view for the duration of the drag, then
  // restore it on dragend/drop.
  const [dragging, setDragging] = useState(false);

  // Latest device-mode / responsive-size, read inside the bounds effect WITHOUT
  // adding them to its deps (which would tear down + re-register the whole
  // ResizeObserver/listener stack on every drag frame).
  const modeRef = useRef(browser.deviceMode);
  modeRef.current = browser.deviceMode;
  const respRef = useRef(browser.responsiveSize);
  respRef.current = browser.responsiveSize;

  // Responsive-resize: drag a handle to resize the emulated viewport. We HIDE
  // the native view for the drag (via the same pane-resize events the divider
  // uses) so the renderer keeps the pointer stream — the OS-level view would
  // otherwise steal pointermove the instant the cursor crossed it. A DOM
  // outline previews the target size; on release the view re-shows at it.
  const MIN_RESP = 240;
  const onResizeHandle = (axis: 'x' | 'y' | 'xy') => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = placeholderRef.current;
    if (!el) return;
    const pr = el.getBoundingClientRect();
    const start = browser.responsiveSize ?? {
      width: Math.max(MIN_RESP, Math.round(pr.width * 0.7)),
      height: Math.max(MIN_RESP, Math.round(pr.height * 0.7)),
    };
    window.dispatchEvent(new Event('topics:pane-resize-start'));
    const move = (ev: PointerEvent) => {
      let w = start.width, h = start.height;
      if (axis !== 'y') w = Math.max(MIN_RESP, Math.min(Math.round(ev.clientX - pr.left), Math.round(pr.width)));
      if (axis !== 'x') h = Math.max(MIN_RESP, Math.min(Math.round(ev.clientY - pr.top), Math.round(pr.height)));
      browser.setResponsiveSize(w, h);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.dispatchEvent(new Event('topics:pane-resize-end'));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Agent activity NO LONGER touches this view's bounds. The agent drives the
  // SAME native WebContentsView over CDP, so the user already watches it work;
  // the "agent is controlling" indicator now lives in the browser toolbar
  // (AgentActivityPill) where it can't shift/reflow the page. The previous
  // implementation inset the view by a top strip on every tool call, making the
  // page visibly jump — which is exactly what we're removing here.

  // Track HTML5 drag operations globally. dragstart fires once when the
  // user begins dragging anything (a tab in PaneTabBar, an item from a
  // list, a file from outside, …). dragend fires when the drag concludes
  // (drop or cancel). We hide the WebContentsView for the duration so
  // React-rendered drag previews/indicators are visible.
  useEffect(() => {
    let count = 0;
    const onStart = () => {
      count += 1;
      if (count === 1) setDragging(true);
    };
    const onEnd = () => {
      count = Math.max(0, count - 1);
      if (count === 0) {
        // Tiny defer so the drop animation completes before the view
        // re-mounts at full bounds (avoids a 1-frame flicker).
        setTimeout(() => setDragging(false), 60);
      }
    };
    window.addEventListener('dragstart', onStart, true);
    window.addEventListener('dragend', onEnd, true);
    window.addEventListener('drop', onEnd, true);
    // A divider RESIZE is a raw mousedown-drag, not an HTML5 drag, so it never
    // fires dragstart. Without this the OS-level WebContentsView stays on top
    // during a resize and swallows the pointer, freezing the drag the moment it
    // crosses a browser pane. useGridResize dispatches these on real drag only.
    window.addEventListener('topics:pane-resize-start', onStart, true);
    window.addEventListener('topics:pane-resize-end', onEnd, true);
    return () => {
      window.removeEventListener('dragstart', onStart, true);
      window.removeEventListener('dragend', onEnd, true);
      window.removeEventListener('drop', onEnd, true);
      window.removeEventListener('topics:pane-resize-start', onStart, true);
      window.removeEventListener('topics:pane-resize-end', onEnd, true);
    };
  }, []);

  // Drive setBounds from layout. ResizeObserver catches size changes on the
  // placeholder itself, but split-layout drag, sidebar collapse, sibling
  // pane resize don't always fire RO (when placeholder size doesn't change
  // but its position does). Defensive layers:
  //  1. ResizeObserver on the placeholder (size changes)
  //  2. ResizeObserver on document.body (sibling/parent resize)
  //  3. window resize + scroll (capture: true catches inner scroll)
  //  4. requestAnimationFrame poll for ~500ms after viewId/agentActive/
  //     dragging change (smoothes split transition while CSS animations settle)
  //  5. MutationObserver on body class — picks up theme/sidebar toggles
  //     that re-flow without firing RO
  useEffect(() => {
    if (!browser.viewId) return;

    let lastSentJson = '';
    const updateBounds = () => {
      const el = placeholderRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();

      // Hide entirely while:
      // - the parent pane is `display:none` in a keep-alive ladder
      //   (display:none doesn't reliably fire ResizeObserver, so we
      //   trust the explicit prop instead of relying on the rect)
      // - a global drag is in progress (drop preview must be visible)
      // NOTE: agent activity does NOT affect bounds — the view fills the
      // placeholder at all times (the "controlling" indicator lives in the
      // toolbar, so the page never shifts when the agent acts).
      // Pull the OS-level view IN by a hair on every side. The WebContentsView
      // composites ABOVE the DOM, so when it fills the placeholder edge-to-edge
      // it sits on top of the 1px resize dividers that live at the pane
      // boundary — the real pointer hits the page, never the DOM divider, so
      // hover/grab feel dead next to a browser pane. z-index can't lift a DOM
      // handle over a native view; the only fix is to expose a thin DOM gutter
      // where the divider's grab zone can actually receive the pointer.
      const mode = modeRef.current;
      const resp = respRef.current;
      // Responsive mode (deviceMode==='custom'): seed a sensible initial size on
      // first entry, then size the view to it (top-left) so the page reflows
      // like a real window — the uncovered pane area holds the drag handles.
      if (mode === 'custom' && !resp && isVisible && !dragging) {
        browser.setResponsiveSize(
          Math.max(MIN_RESP, Math.round(rect.width * 0.7)),
          Math.max(MIN_RESP, Math.round(rect.height * 0.7)),
        );
      }
      const next = (!isVisible || dragging)
        ? { x: 0, y: 0, width: 0, height: 0 }
        : (mode === 'custom' && resp)
          ? {
              x: rect.left,
              y: rect.top,
              width: Math.max(0, Math.min(resp.width, Math.round(rect.width))),
              height: Math.max(0, Math.min(resp.height, Math.round(rect.height))),
            }
          : {
              x: rect.left + NATIVE_VIEW_GUTTER,
              y: rect.top + NATIVE_VIEW_GUTTER,
              width: Math.max(0, rect.width - 2 * NATIVE_VIEW_GUTTER),
              height: Math.max(0, rect.height - 2 * NATIVE_VIEW_GUTTER),
            };

      // Coalesce — skip the IPC if bounds didn't change. setBounds rounds
      // to integers main-side, so we round here too for cheap equality.
      const json = `${Math.round(next.x)},${Math.round(next.y)},${Math.round(next.width)},${Math.round(next.height)}`;
      if (json === lastSentJson) return;
      lastSentJson = json;
      browser.setBounds(next);
    };

    updateBounds();

    const ro = new ResizeObserver(updateBounds);
    if (placeholderRef.current) ro.observe(placeholderRef.current);
    // Observe body too — picks up sibling pane resize / sidebar collapse
    // even when the placeholder's own size doesn't change.
    ro.observe(document.body);

    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, { passive: true, capture: true });

    // Phase 30.1 polish — main process emits 'reflow' on window move /
    // minimize / restore / display change. Re-issue setBounds so the
    // WebContentsView follows correctly across these transitions.
    const offReflow = window.electronAPI?.browserNative?.onReflow?.(() => {
      // Two-frame delay so the layout has settled (e.g. fullscreen
      // transition animation) before we re-measure.
      requestAnimationFrame(() => requestAnimationFrame(updateBounds));
    });

    // MutationObserver on body: catches className toggles (theme, sidebar
    // open/close) that re-flow without firing RO.
    const mo = new MutationObserver(updateBounds);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'], subtree: false });

    // Poll briefly to smooth split/transition animations. CSS transitions
    // don't fire RO during their interpolation phase.
    let pollCount = 0;
    const maxPolls = 30; // ~500ms at 60fps
    let rafId = 0;
    const poll = () => {
      updateBounds();
      pollCount += 1;
      if (pollCount < maxPolls) rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);

    // CSS transitions on ancestor elements (split-cell width changes,
    // sidebar collapse, group reflow) interpolate between frames and
    // their final state often lands AFTER the 500ms poll above. Listen
    // for `transitionend` events bubbling up from the placeholder's
    // ancestors and re-measure once they settle. The capture phase
    // catches transitions on parent containers that don't bubble in
    // the standard sense (some flex container transitions are pinned
    // to specific elements). Idempotent: updateBounds short-circuits
    // when the rect hasn't actually changed.
    const onTransitionEnd = (e: TransitionEvent) => {
      const target = e.target as Node | null;
      if (target instanceof Element && (target.contains(placeholderRef.current) || placeholderRef.current?.contains(target))) {
        // Two-frame defer so any compositing work settles before we
        // hand the rect to the OS-level overlay.
        requestAnimationFrame(() => requestAnimationFrame(updateBounds));
      }
    };
    window.addEventListener('transitionend', onTransitionEnd, true);

    // External reflow request — when the user jumps to this browser pane
    // from a chat header button, the chat dispatches `browser:reflow-request`
    // so the placeholder forces an immediate `setBounds`. Cures the
    // white-screen case where the WebContentsView is stuck at {0,0,0,0}
    // because the layout's polling window expired before CSS transitions
    // settled. We also bust the coalescing cache so updateBounds actually
    // emits — otherwise lastSentJson would short-circuit a no-op.
    const onReflowRequest = (ev: Event) => {
      const ce = ev as CustomEvent<{ contextId?: string }>;
      // No contextId filter = reflow all; otherwise match this pane's view.
      if (ce.detail?.contextId && ce.detail.contextId && !browser.viewId) return;
      lastSentJson = '';
      requestAnimationFrame(() => requestAnimationFrame(updateBounds));
    };
    window.addEventListener('browser:reflow-request', onReflowRequest as EventListener);

    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, { capture: true });
      window.removeEventListener('transitionend', onTransitionEnd, true);
      window.removeEventListener('browser:reflow-request', onReflowRequest as EventListener);
      offReflow?.();
      // On unmount, hide the view (the destroy in useNativeBrowser will
      // remove it shortly after).
      browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: depend on the specific fields the effect reads (viewId/setBounds — grep-verified the only browser.* uses), NOT the whole `browser` object. useNativeBrowser rebuilds that object every render, so depending on it re-ran this ResizeObserver/MutationObserver/rAF-poll/listener effect on EVERY render. setBounds is useCallback([viewId]) so its identity only changes with viewId (already a dep). The rule can't see the member coverage and asks for the parent object.
  }, [browser.viewId, browser.setBounds, dragging, isVisible]);

  // Re-issue bounds when entering/leaving responsive mode or when the size
  // changes via a non-drag path (preset select, W×H input). The main effect
  // intentionally does NOT depend on deviceMode/responsiveSize (it would
  // re-register its observers every drag frame), so nudge a single setBounds
  // here. Seeds the initial size on first entry. During a drag this early-
  // returns (the view is hidden); on release the new size lands here.
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el || !browser.viewId || !isVisible || dragging) return;
    const rect = el.getBoundingClientRect();
    if (browser.deviceMode === 'custom') {
      if (!browser.responsiveSize) {
        browser.setResponsiveSize(
          Math.max(MIN_RESP, Math.round(rect.width * 0.7)),
          Math.max(MIN_RESP, Math.round(rect.height * 0.7)),
        );
        return;
      }
      browser.setBounds({
        x: rect.left,
        y: rect.top,
        width: Math.max(0, Math.min(browser.responsiveSize.width, Math.round(rect.width))),
        height: Math.max(0, Math.min(browser.responsiveSize.height, Math.round(rect.height))),
      });
    } else {
      browser.setBounds({
        x: rect.left + NATIVE_VIEW_GUTTER,
        y: rect.top + NATIVE_VIEW_GUTTER,
        width: Math.max(0, rect.width - 2 * NATIVE_VIEW_GUTTER),
        height: Math.max(0, rect.height - 2 * NATIVE_VIEW_GUTTER),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- MIN_RESP is a module-level constant
  }, [browser.viewId, browser.deviceMode, browser.responsiveSize, browser.setBounds, browser.setResponsiveSize, isVisible, dragging]);

  const resp = browser.responsiveSize;
  const responsive = browser.deviceMode === 'custom' && !!resp;

  return (
    <div
      ref={placeholderRef}
      className="flex-1 min-h-0 overflow-hidden bg-surface relative"
      data-testid="browser-native-placeholder"
    >
      {/* Loading shimmer while WebContentsView spins up. */}
      {!browser.ready && (
        <div className="absolute inset-0 flex items-center justify-center text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Initializing native browser...
        </div>
      )}

      {/* Freeze-frame (Tauri only — `frozenImage` is undefined on Electron). A
          native child webview composites ABOVE the DOM, so while a dropdown
          overlaps it or a sidebar/divider animation is in flight the live view is
          parked off-screen and this PNG still stands in. Overlays render over it
          by normal z-index; animations stretch a cheap bitmap instead of moving
          the native view per-frame. pointer-events-none — it's a non-interactive
          stand-in, and the live view is parked while it shows. */}
      {browser.frozenImage && (
        <img
          src={browser.frozenImage}
          alt=""
          aria-hidden
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover object-left-top pointer-events-none select-none"
          data-testid="browser-frozen-frame"
        />
      )}
      {/* The "agent is controlling" indicator lives in the toolbar
          (AgentActivityPill) — it no longer insets this view, so the page
          never jumps when the agent acts. */}

      {/* Responsive design mode — drag handles around the (smaller) viewport.
          The native view sizes to resp W×H at the top-left; the rest of the
          pane is this DOM, where the handles live. While dragging, the view is
          hidden and this outline previews the target size. */}
      {responsive && resp && (
        <>
          <div
            className="absolute left-0 top-0 border-r border-b border-primary/50 pointer-events-none"
            style={{ width: resp.width, height: resp.height }}
            aria-hidden
          />
          {/* right edge — width */}
          <div
            onPointerDown={onResizeHandle('x')}
            className="absolute top-0 bottom-0 w-2.5 z-10 cursor-ew-resize group"
            style={{ left: resp.width }}
            data-testid="browser-responsive-handle-x"
            title="Trascina per la larghezza"
          >
            <div className="absolute inset-y-0 left-0 w-0.5 bg-primary/40 group-hover:bg-primary transition-colors" />
          </div>
          {/* bottom edge — height */}
          <div
            onPointerDown={onResizeHandle('y')}
            className="absolute left-0 right-0 h-2.5 z-10 cursor-ns-resize group"
            style={{ top: resp.height }}
            data-testid="browser-responsive-handle-y"
            title="Trascina per l'altezza"
          >
            <div className="absolute inset-x-0 top-0 h-0.5 bg-primary/40 group-hover:bg-primary transition-colors" />
          </div>
          {/* corner — both */}
          <div
            onPointerDown={onResizeHandle('xy')}
            className="absolute w-3.5 h-3.5 z-20 cursor-nwse-resize bg-primary rounded-sm shadow ring-2 ring-surface"
            style={{ left: resp.width - 6, top: resp.height - 6 }}
            data-testid="browser-responsive-handle-xy"
            title="Trascina per ridimensionare"
          />
          {/* size readout */}
          <div className="absolute left-2 bottom-2 z-10 px-2 py-0.5 rounded-md glass-surface border border-app-border text-[11px] tabular-nums text-app-text-secondary pointer-events-none select-none">
            {resp.width} × {resp.height}
          </div>
        </>
      )}
    </div>
  );
}

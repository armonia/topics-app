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
import { Bot, Loader2 } from 'lucide-react';
import type { NativeBrowserHandle } from '../../hooks/useNativeBrowser';

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
    return () => {
      window.removeEventListener('dragstart', onStart, true);
      window.removeEventListener('dragend', onEnd, true);
      window.removeEventListener('drop', onEnd, true);
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

      // Hide while:
      // - the parent pane is `display:none` in a keep-alive ladder
      //   (display:none doesn't reliably fire ResizeObserver, so we
      //   trust the explicit prop instead of relying on the rect)
      // - agent is controlling (React overlay covers the slot)
      // - a global drag is in progress (drop preview must be visible)
      const next = (!isVisible || browser.agentActive || dragging)
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: rect.left, y: rect.top, width: rect.width, height: rect.height };

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

    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, { capture: true });
      offReflow?.();
      // On unmount, hide the view (the destroy in useNativeBrowser will
      // remove it shortly after).
      browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, [browser.viewId, browser.agentActive, dragging, isVisible, browser]);

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

      {/* Agent lock overlay — same UX as Phase 30 streaming mode. */}
      {browser.agentActive && (
        <div
          className="absolute inset-0 bg-surface/80 backdrop-blur-sm flex flex-col items-center justify-center z-50"
          data-testid="browser-agent-active-overlay"
        >
          <Bot className="w-8 h-8 mb-2 text-accent" />
          <div className="text-sm font-medium">Agent is controlling the browser</div>
          <div className="text-xs text-text-muted mt-1">Native CDP path</div>
        </div>
      )}
    </div>
  );
}

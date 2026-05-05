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
import { useEffect, useRef } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import type { NativeBrowserHandle } from '../../hooks/useNativeBrowser';

interface NativeBrowserPlaceholderProps {
  browser: NativeBrowserHandle;
}

export function NativeBrowserPlaceholder({ browser }: NativeBrowserPlaceholderProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);

  // Drive setBounds from layout. ResizeObserver fires on every size or
  // position change. We also listen for window scroll (the placeholder
  // can move within the page).
  useEffect(() => {
    if (!browser.viewId) return;

    const updateBounds = () => {
      const el = placeholderRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();

      if (browser.agentActive) {
        // Hide while agent works — the React overlay below covers the slot.
        browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }

      browser.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    updateBounds();

    const ro = new ResizeObserver(updateBounds);
    if (placeholderRef.current) ro.observe(placeholderRef.current);

    // Catch scroll + window resize (RO doesn't fire on viewport-relative shifts).
    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, { passive: true, capture: true });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, { capture: true });
      // On unmount, hide the view (the destroy in useNativeBrowser will
      // remove it shortly after).
      browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }, [browser.viewId, browser.agentActive, browser]);

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

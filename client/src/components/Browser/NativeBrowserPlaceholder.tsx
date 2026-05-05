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
 * On any DOM overlay (dropdown/modal/popover/menu): hide the WebContentsView
 * temporarily so the React DOM overlay is visible. WebContentsView is
 * OS-level and renders ABOVE all DOM, so we can't z-index our way around
 * it. Detection: MutationObserver on body for overlay role attributes,
 * + a custom data-attribute hook (data-browser-native-hide="true") for
 * arbitrary triggers (chat command palette, settings modal, etc).
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
}

// Selectors that indicate a blocking DOM overlay is shown over the page.
// When ANY matches a visible element, we hide the WebContentsView so the
// React overlay (dropdown/menu/modal) becomes visible.
const OVERLAY_SELECTORS = [
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[data-overlay="true"]',
  '[data-browser-native-hide="true"]',
  // Common React UI library portals
  '[data-radix-popper-content-wrapper]',
  '[data-headlessui-state="open"]',
];

function hasVisibleOverlay(): boolean {
  for (const sel of OVERLAY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    // Check that element is actually visible (not display:none / aria-hidden).
    const style = window.getComputedStyle(el as Element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if ((el as HTMLElement).offsetParent === null && style.position !== 'fixed') continue;
    return true;
  }
  return false;
}

export function NativeBrowserPlaceholder({ browser }: NativeBrowserPlaceholderProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const [hasOverlay, setHasOverlay] = useState(false);

  // Watch DOM for overlays (dropdowns/modals/menus). When detected, hide
  // the WebContentsView so the overlay is visible above the placeholder slot.
  useEffect(() => {
    let raf = 0;
    const recheck = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setHasOverlay(hasVisibleOverlay()));
    };

    // Initial check
    recheck();

    // Watch additions/removals + attribute changes (e.g. aria-hidden toggles)
    const mo = new MutationObserver(recheck);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'aria-hidden', 'data-overlay', 'data-browser-native-hide', 'data-state', 'data-headlessui-state'],
    });

    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Drive setBounds from layout. ResizeObserver fires on every size or
  // position change. We also listen for window scroll (the placeholder
  // can move within the page).
  useEffect(() => {
    if (!browser.viewId) return;

    const updateBounds = () => {
      const el = placeholderRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();

      // Hide WebContentsView when:
      // - Agent is controlling (React overlay needs to cover slot)
      // - A DOM overlay (dropdown/modal/menu) is visible (React overlay
      //   needs to be visible OVER the WebContentsView, but OS-level
      //   wins — so we shrink it to 0,0,0,0 instead).
      if (browser.agentActive || hasOverlay) {
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
  }, [browser.viewId, browser.agentActive, hasOverlay, browser]);

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

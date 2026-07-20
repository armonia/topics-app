/**
 * DevBundleToast — "a newer build is available" prompt.
 *
 * The manual-reload replacement for devBundleReload's old silent auto-reload
 * (see lib/devBundleReload.ts, "gestiamo meglio l'hot-reload" 2026-07-20). It
 * listens for a single window event, `BUNDLE_STALE_EVENT`, fired by BOTH the
 * dev rev-mismatch check AND the chunk-load error guard, and renders a small
 * actionable card. The window is NEVER reloaded without the user clicking.
 *
 * Placement mirrors UpdaterToast: anchored just above the sidebar version chip
 * ([data-version-anchor]) when present, bottom-right corner otherwise. Kept a
 * separate component from UpdaterToast on purpose — that one drives the NATIVE
 * app updater (download/restart a signed release); this one is the in-page
 * bundle refresh. Different lifecycles, same visual language.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import { BUNDLE_STALE_EVENT, reloadForNewBundle } from '@/lib/devBundleReload';
import { Z_POPOVER } from '@/lib/popoverStyles';

const VERSION_ANCHOR_SELECTOR = '[data-version-anchor]';

export function DevBundleToast() {
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const onStale = () => {
      setStale(true);
      // A fresh signal re-surfaces the prompt even if a previous one was
      // dismissed — the bundle moved again, the user should know.
      setDismissed(false);
    };
    window.addEventListener(BUNDLE_STALE_EVENT, onStale);
    return () => window.removeEventListener(BUNDLE_STALE_EVENT, onStale);
  }, []);

  // Re-anchor on resize while visible (the anchor rect is read at render).
  const [, forceReposition] = useState(0);
  useEffect(() => {
    if (!stale || dismissed) return;
    const onResize = () => forceReposition((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [stale, dismissed]);

  if (!stale || dismissed) return null;

  const card = (
    <div
      className="rounded-lg border shadow-lg p-3 flex items-start gap-2 bg-app-hover border-app-border-light text-app-text"
      data-testid="bundle-stale-toast"
    >
      <RefreshCw size={14} className="mt-0.5 text-primary" />
      <div className="flex-1 text-[12px]">
        <div className="font-medium">Nuova versione disponibile</div>
        <button
          onClick={() => reloadForNewBundle()}
          className="mt-1 text-primary underline underline-offset-2 hover:no-underline"
          data-testid="bundle-stale-reload"
        >
          Ricarica
        </button>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-app-text-muted hover:text-app-text leading-none"
        aria-label="Ignora"
      >
        ×
      </button>
    </div>
  );

  // Anchor above the version chip when present; clamp so the card never lands
  // off-screen for a collapsed sidebar (narrow anchor → corner fallback), same
  // guards as UpdaterToast (BRW-REL-03).
  const anchor = document.querySelector<HTMLElement>(VERSION_ANCHOR_SELECTOR);
  const anchorRect = anchor?.getBoundingClientRect();
  const usableAnchor = anchorRect && anchorRect.width >= 40 ? anchorRect : null;
  if (usableAnchor) {
    const TOAST_MAX_WIDTH = 320;
    const right = Math.max(
      8,
      Math.min(window.innerWidth - usableAnchor.right, window.innerWidth - TOAST_MAX_WIDTH - 8),
    );
    return createPortal(
      <div
        role="status"
        aria-live="polite"
        className="max-w-xs"
        style={{
          position: 'fixed',
          bottom: window.innerHeight - usableAnchor.top + 6,
          right,
          zIndex: Z_POPOVER,
        }}
      >
        {card}
      </div>,
      document.body,
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-xs" role="status" aria-live="polite">
      {card}
    </div>
  );
}

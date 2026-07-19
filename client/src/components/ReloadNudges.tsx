/**
 * ReloadNudges — the two "you're looking at a stale app" prompts that used to
 * fail silently. Rendered once at the App root (next to UpdaterToast), fixed in
 * the bottom-right corner.
 *
 *  1. Bundle stuck — the dev hot-delivery auto-reload (devBundleReload.ts) gives
 *     up after MAX_RELOAD_ATTEMPTS when the WKWebView keeps serving its cached
 *     index.html: before, the window just disarmed with a console.warn and no
 *     visible signal. Now it fires BUNDLE_STUCK_EVENT and we surface a banner
 *     with a manual "Ricarica" (cache-busted reload, or a true process restart
 *     on desktop where that actually clears the native cache).
 *
 *  2. Service-worker waiting — a new SW can sit in `waiting` indefinitely (we
 *     never auto-activate, by design, so the app doesn't reload under the user).
 *     After it's been waiting a while we nudge with a toast offering to apply it,
 *     instead of relying on the user noticing the tinted sidebar ⟳.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Sparkles } from 'lucide-react';
import { BUNDLE_STUCK_EVENT, retryBundleReload } from '@/lib/devBundleReload';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { isDesktop } from '@/lib/shell';
import { relaunch } from '@/lib/shell/app';
import { Z_POPOVER } from '@/lib/popoverStyles';

// How long a service worker may sit in `waiting` before we proactively nudge.
const SW_WAITING_NUDGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border shadow-lg p-3 flex items-start gap-2 bg-app-hover border-app-border-light text-app-text max-w-xs text-[12px]">
      {children}
    </div>
  );
}

export function ReloadNudges() {
  const [bundleStuck, setBundleStuck] = useState(false);
  const [bundleDismissed, setBundleDismissed] = useState(false);
  const { waitingSince, applyUpdate } = useServiceWorkerUpdate();
  const [swNudge, setSwNudge] = useState(false);
  const [swDismissed, setSwDismissed] = useState(false);

  // Bundle-stuck: the auto-reload gave up behind a stale cache.
  useEffect(() => {
    const onStuck = () => { setBundleStuck(true); setBundleDismissed(false); };
    window.addEventListener(BUNDLE_STUCK_EVENT, onStuck);
    return () => window.removeEventListener(BUNDLE_STUCK_EVENT, onStuck);
  }, []);

  // SW-waiting: arm the nudge once the waiting clock crosses the threshold. If
  // it's already past (persisted across reloads), show immediately; otherwise
  // schedule a one-shot timer for the exact remaining time.
  useEffect(() => {
    if (!waitingSince) { setSwNudge(false); return; }
    const elapsed = Date.now() - waitingSince;
    if (elapsed >= SW_WAITING_NUDGE_MS) { setSwNudge(true); return; }
    const t = window.setTimeout(() => setSwNudge(true), SW_WAITING_NUDGE_MS - elapsed);
    return () => window.clearTimeout(t);
  }, [waitingSince]);

  const applySwUpdate = () => {
    // Reload once the new worker takes control so we actually load its assets.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => window.location.reload(),
        { once: true },
      );
    }
    applyUpdate();
  };

  const retryBundle = async () => {
    if (isDesktop) {
      // A true process restart clears the WKWebView native cache that a plain
      // reload can't reach — the actual escape hatch on desktop.
      try { await relaunch(); return; } catch { /* fall through to reload */ }
    }
    retryBundleReload();
  };

  const showBundle = bundleStuck && !bundleDismissed;
  const showSw = swNudge && !swDismissed && !!waitingSince;
  if (!showBundle && !showSw) return null;

  return createPortal(
    <div
      className="fixed bottom-4 right-4 flex flex-col gap-2"
      style={{ zIndex: Z_POPOVER }}
      role="status"
      aria-live="polite"
    >
      {showBundle && (
        <Card>
          <RefreshCw size={14} className="mt-0.5 text-app-text-muted" />
          <div className="flex-1">
            <div className="font-medium">Nuovo bundle disponibile</div>
            <div className="text-app-text-muted">Il ricarico automatico si è fermato (cache stantìa).</div>
            <button
              onClick={retryBundle}
              className="mt-1 text-app-text underline underline-offset-2 hover:no-underline"
            >
              {isDesktop ? 'Riavvia l’app' : 'Ricarica'}
            </button>
          </div>
          <button
            onClick={() => setBundleDismissed(true)}
            className="text-app-text-muted hover:text-app-text leading-none"
            aria-label="Ignora"
          >
            ×
          </button>
        </Card>
      )}
      {showSw && (
        <Card>
          <Sparkles size={14} className="mt-0.5 text-app-text-muted" />
          <div className="flex-1">
            <div className="font-medium">Aggiornamento pronto</div>
            <div className="text-app-text-muted">Un aggiornamento è in attesa da un po’.</div>
            <button
              onClick={applySwUpdate}
              className="mt-1 text-app-text underline underline-offset-2 hover:no-underline"
            >
              Applica e ricarica
            </button>
          </div>
          <button
            onClick={() => setSwDismissed(true)}
            className="text-app-text-muted hover:text-app-text leading-none"
            aria-label="Ignora"
          >
            ×
          </button>
        </Card>
      )}
    </div>,
    document.body,
  );
}

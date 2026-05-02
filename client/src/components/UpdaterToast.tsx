/**
 * Phase E · UpdaterToast — sticky-when-ready notification.
 *
 * Listens to `updater:status` events broadcast from `electron-app/main.ts`
 * and renders a small fixed-position toast in the bottom-right corner.
 *
 * Behaviour mirrors the reference desktop client we studied:
 *   · `idle`              → nothing rendered
 *   · `checking`          → small "Checking for updates…" hint
 *   · `update-available`  → "An update is available — downloading…"
 *   · `downloading {pct}` → progress badge
 *   · `ready`             → STICKY (cannot dismiss) "A new version is
 *                           ready" + "Restart to Update" CTA
 *   · `error`             → small dismissable error
 *
 * The toast is rendered at the App root and consumes
 * `window.electronAPI.updater` directly — no React state plumbing
 * needed beyond the listener.
 */
import { useEffect, useState } from 'react';
import { RefreshCw, Check, AlertCircle, Download } from 'lucide-react';

interface UpdaterStatus {
  state: 'idle' | 'checking' | 'update-available' | 'downloading' | 'ready' | 'error';
  progress?: number;
  error?: string;
}

interface ElectronUpdater {
  checkForUpdates: () => Promise<{ ok: boolean; reason?: string }>;
  status: () => Promise<UpdaterStatus>;
  quitAndInstall: () => Promise<{ ok: boolean; reason?: string }>;
  onStatus: (cb: (s: UpdaterStatus) => void) => () => void;
}

export function UpdaterToast() {
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    const api = (window as any).electronAPI?.updater as ElectronUpdater | undefined;
    if (!api) return;
    api.status().then(setStatus).catch(() => {});
    return api.onStatus((s) => {
      setStatus(s);
      // Re-show on every state change so a previously-dismissed error
      // can re-surface when a new check runs.
      setDismissed(false);
    });
  }, []);

  if (status.state === 'idle' || dismissed) return null;

  const isReady = status.state === 'ready';
  const isError = status.state === 'error';

  return (
    <div
      className="fixed bottom-4 right-4 z-50 max-w-xs"
      role="status"
      aria-live="polite"
    >
      <div className={`rounded-lg border shadow-lg p-3 flex items-start gap-2 ${
        isReady ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300' :
        isError ? 'bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300' :
        'bg-app-hover border-app-border-light text-app-text'
      }`}>
        {status.state === 'checking' && <RefreshCw size={14} className="mt-0.5 animate-spin" />}
        {(status.state === 'update-available' || status.state === 'downloading') && <Download size={14} className="mt-0.5" />}
        {isReady && <Check size={14} className="mt-0.5" />}
        {isError && <AlertCircle size={14} className="mt-0.5" />}
        <div className="flex-1 text-[12px]">
          {status.state === 'checking' && 'Checking for updates…'}
          {status.state === 'update-available' && 'An update is available — downloading…'}
          {status.state === 'downloading' && (
            <>Downloading update{status.progress !== undefined ? `… ${Math.round(status.progress)}%` : '…'}</>
          )}
          {isReady && (
            <>
              <div className="font-medium">A new version of Topics is ready</div>
              <button
                onClick={async () => {
                  const api = (window as any).electronAPI?.updater as ElectronUpdater | undefined;
                  if (api) await api.quitAndInstall();
                }}
                className="mt-1 text-emerald-700 dark:text-emerald-300 underline underline-offset-2 hover:no-underline"
              >
                Restart to Update
              </button>
            </>
          )}
          {isError && <span>{status.error || 'Update failed'}</span>}
        </div>
        {/* Sticky on ready: no close button. Otherwise allow dismiss. */}
        {!isReady && (
          <button
            onClick={() => setDismissed(true)}
            className="text-app-text-muted hover:text-app-text leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

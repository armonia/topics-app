/**
 * Phase E · UpdaterToast — opt-in update notifications.
 *
 * Subscribes to the host updater (Electron's `updater:*` IPC, or the Tauri
 * updater adapter in lib/updater.ts) and renders a small fixed-position toast
 * in the bottom-right corner.
 *
 * Behaviour (revised 2026-05-11 — opt-in only, no surprise downloads):
 *   · `idle`              → nothing rendered
 *   · `checking`          → small "Checking for updates…" hint
 *   · `update-available`  → "Update vX.Y.Z available" + "Download" CTA
 *                           (the user MUST click to actually download —
 *                           server has `autoDownload: false`)
 *   · `downloading {pct}` → progress badge
 *   · `ready`             → STICKY (cannot dismiss) "A new version is
 *                           ready" + "Restart to Update" CTA
 *   · `error`             → small dismissable error
 *
 * The toast is rendered at the App root and consumes the host updater via
 * `getUpdaterApi()` (lib/updater.ts) — no React state plumbing needed beyond
 * the listener.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Check, AlertCircle, Download } from 'lucide-react';
import { getUpdaterApi, shouldShowUpdaterToast, type UpdaterStatus } from '@/lib/updater';
import { Z_POPOVER } from '@/lib/popoverStyles';

// The version chip in the sidebar status bar tags itself with this attribute so
// the toast can sit directly ABOVE it ("sopra la versione") instead of a
// bottom-right corner that hides behind the panes. Falls back to the corner when
// the chip isn't in the DOM (collapsed sidebar / web without a status bar).
const VERSION_ANCHOR_SELECTOR = '[data-version-anchor]';

export function UpdaterToast() {
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState<boolean>(false);
  // While the VersionPopover is open it OWNS the update surface: it anchors to
  // the same version chip and carries the full check/download/install flow, so
  // this toast rendering too stacked two update cards on top of each other
  // ("due modali una nell'altra", reported live 2026-07-11) — every status
  // change re-un-dismisses the toast, including the ones the popover's own
  // buttons cause. Suppress the toast while the popover reports itself open.
  const [versionPopoverOpen, setVersionPopoverOpen] = useState(false);
  useEffect(() => {
    const onPopover = (e: Event) => {
      setVersionPopoverOpen(!!(e as CustomEvent<{ open?: boolean }>).detail?.open);
    };
    window.addEventListener('topics:version-popover', onPopover);
    return () => window.removeEventListener('topics:version-popover', onPopover);
  }, []);

  useEffect(() => {
    const api = getUpdaterApi();
    if (!api) return;
    api.status().then(setStatus).catch(() => {});
    const off = api.onStatus((s) => {
      setStatus(s);
      // Re-show on every state change so a previously-dismissed error
      // can re-surface when a new check runs.
      setDismissed(false);
    });

    // Auto-check for updates shortly after launch so "riceve aggiornamenti
    // successivi" is real — nothing else calls check() on boot, so an available
    // update would otherwise never surface until the user opened the version
    // popover. Delayed a few seconds to let first paint + the sidecar settle.
    //
    // SILENZIOSO: finché non esiste una release firmata l'endpoint risponde 404,
    // e questo controllo automatico piazzava un toast di errore a OGNI avvio —
    // per una cosa che l'utente non ha chiesto e non può risolvere. Con
    // `silent` il boot non disegna né il "controllo in corso" né l'esito
    // negativo; un aggiornamento davvero disponibile esce lo stesso, perché lo
    // status arriva marcato non-silenzioso. Il controllo dal menu resta
    // rumoroso: lì l'esito l'ha chiesto l'utente, e "sei aggiornato" è la
    // risposta. (Entrambi gli host, Electron e Tauri.)
    const bootCheck = window.setTimeout(() => {
      api.checkForUpdates({ silent: true }).catch(() => {});
    }, 4000);

    // Native menu "Controlla aggiornamenti…" (Tauri) dispatches this DOM event.
    const onMenuCheck = () => { api.checkForUpdates().catch(() => {}); };
    window.addEventListener('topics:check-for-updates', onMenuCheck);

    return () => {
      off?.();
      window.clearTimeout(bootCheck);
      window.removeEventListener('topics:check-for-updates', onMenuCheck);
    };
  }, []);

  // Re-anchor the toast when the window resizes while it's visible — the
  // anchor's live geometry (read at render, below) would otherwise drift.
  const [, forceReposition] = useState(0);
  useEffect(() => {
    if (status.state === 'idle') return;
    const onResize = () => forceReposition((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [status.state]);

  if (!shouldShowUpdaterToast(status, { dismissed, versionPopoverOpen })) return null;

  const isReady = status.state === 'ready';
  const isError = status.state === 'error';

  const card = (
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
          {status.state === 'update-available' && (
            <>
              <div className="font-medium">An update is available</div>
              <button
                onClick={async () => {
                  const api = getUpdaterApi();
                  if (api?.downloadUpdate) {
                    await api.downloadUpdate();
                  } else {
                    // Fallback for older preloads that don't expose downloadUpdate:
                    // re-running checkForUpdates with the legacy autoDownload=true
                    // would have triggered a fetch. With opt-in flow this is just
                    // a no-op safety net.
                    await api?.checkForUpdates();
                  }
                }}
                className="mt-1 text-app-text underline underline-offset-2 hover:no-underline"
              >
                Download update
              </button>
            </>
          )}
          {status.state === 'downloading' && (
            <>Downloading update{status.progress !== undefined ? `… ${Math.round(status.progress)}%` : '…'}</>
          )}
          {isReady && (
            <>
              <div className="font-medium">A new version of Topics is ready</div>
              <button
                onClick={async () => {
                  const api = getUpdaterApi();
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
  );

  // Anchor above the version chip when it's in the DOM ("sopra la versione");
  // otherwise fall back to the bottom-right corner. Reading the anchor's rect at
  // render mirrors the status dropdown in SidebarStatusBar.
  //
  // Two viewport guards (BRW-REL-03 — the anchored math once put the toast at
  // x=−80, an invisible error): a COLLAPSED sidebar keeps the chip in the DOM
  // as a narrow icon in the left rail, where right-anchoring pushes the toast
  // off the LEFT edge → treat a narrow anchor as "no anchor" (corner fallback);
  // and clamp `right` so the toast's worst-case width (max-w-xs = 320px) stays
  // inside the viewport even for anchors near the left edge.
  const anchor = document.querySelector<HTMLElement>(VERSION_ANCHOR_SELECTOR);
  const anchorRect = anchor?.getBoundingClientRect();
  const usableAnchor = anchorRect && anchorRect.width >= 40 ? anchorRect : null;
  if (usableAnchor) {
    const TOAST_MAX_WIDTH = 320; // Tailwind max-w-xs
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

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
 *
 * DOVE ATTERRA: nello slot dentro la sidebar, a tutta la sua larghezza — vedi
 * `SidebarUpdateBanner`, che spiega anche perché non è più un cartellino
 * ancorato al numero di versione. Ed è lo stesso componente che usa
 * `DevBundleToast`: i due avvisi si distinguono per l'OCCHIELLO («Nuova
 * versione» qui, «Aggiornamento automatico» là) invece di ripetere la stessa
 * frase con due lifecycle diversi dietro.
 */
import { useEffect, useState } from 'react';
import { useT } from '@/hooks/useT';
import { RefreshCw, Check, AlertCircle, Download } from 'lucide-react';
import { getUpdaterApi, shouldShowUpdaterToast, type UpdaterStatus } from '@/lib/updater';
import { SidebarUpdateBanner } from './Shared/SidebarUpdateBanner';
import { useSystemStatus } from '@/hooks/useSystemStatus';

export function UpdaterToast() {
  const tr = useT();
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState<boolean>(false);
  // While the VersionPopover is open it OWNS the update surface: it anchors to
  // the same version chip and carries the full check/download/install flow, so
  // this toast rendering too stacked two update cards on top of each other
  // ("due modali una nell'altra", reported live 2026-07-11) — every status
  // change re-un-dismisses the toast, including the ones the popover's own
  // buttons cause. Suppress the toast while the popover reports itself open.
  const [versionPopoverOpen, setVersionPopoverOpen] = useState(false);
  // «Automatico» vuol dire che non devi fare niente: vedi
  // `shouldShowUpdaterToast`. Stessa fonte della barra e del pannello della
  // versione - tre letture dello stesso fatto un giorno divergono, e sarebbero
  // tre superfici che dicono tre cose sullo stesso aggiornamento.
  const { status: sistema } = useSystemStatus(true, 60000);
  const autoUpdate = !!sistema?.server?.devReload;
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

  // (Qui stava un listener di `resize` che ri-renderizzava il toast per
  // ricalcolare la sua posizione ancorata. Il banner adesso sta NEL FLUSSO
  // della sidebar: la larghezza gliela dà il layout, e non c'è nessuna
  // geometria da rileggere a mano.)

  if (!shouldShowUpdaterToast(status, { dismissed, versionPopoverOpen, autoUpdate })) return null;

  const isReady = status.state === 'ready';
  const isError = status.state === 'error';

  // Il TITOLO in una riga, e il numero di versione dentro quando c'è: è
  // l'informazione che distingue questo avviso dall'altro («Aggiornamento
  // automatico», il bundle ricostruito) e prima non compariva da nessuna parte.
  const title =
    status.state === 'checking' ? 'Controllo in corso…'
    : status.state === 'update-available' ? (status.version ? `v${status.version} disponibile` : 'Disponibile')
    : status.state === 'downloading' ? `Scarico${status.progress !== undefined ? ` ${Math.round(status.progress)}%` : '…'}`
    : isReady ? 'Pronta da installare'
    : (status.error || 'Aggiornamento fallito');

  return (
    <SidebarUpdateBanner
      kind="release"
      testId="updater-toast"
      tone={isReady ? 'ready' : isError ? 'error' : 'neutral'}
      icon={
        status.state === 'checking' ? <RefreshCw size={14} className="animate-spin" />
        : (status.state === 'update-available' || status.state === 'downloading') ? <Download size={14} />
        : isReady ? <Check size={14} />
        : isError ? <AlertCircle size={14} /> : null
      }
      title={title}
      // Sticky on ready: no close button. Otherwise allow dismiss.
      onDismiss={isReady ? undefined : () => setDismissed(true)}
    >
      {status.state === 'update-available' && (
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
          {tr('update.download')}
        </button>
      )}
      {isReady && (
        <button
          onClick={async () => {
            const api = getUpdaterApi();
            if (api) await api.quitAndInstall();
          }}
          className="mt-1 text-emerald-700 dark:text-emerald-300 underline underline-offset-2 hover:no-underline"
        >
          {tr('update.restartInstall')}
        </button>
      )}
    </SidebarUpdateBanner>
  );
}

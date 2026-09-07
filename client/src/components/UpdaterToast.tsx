/**
 * Phase E · UpdaterToast — opt-in update notifications.
 *
 * Subscribes to the host updater (Electron's `updater:*` IPC, or the Tauri
 * updater adapter in lib/updater.ts) and renders a small fixed-position toast
 * in the bottom-right corner.
 *
 * Behaviour (revised 2026-05-11 — opt-in only, no surprise downloads):
 *   · `idle`              → nothing rendered (no check has been made)
 *   · `up-to-date`        → "You are up to date", the answer to an explicit
 *                           check; a silent boot check stays quiet
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
import { useT } from '../hooks/useT';
import { RefreshCw, Check, AlertCircle, Download } from 'lucide-react';
import {
  getUpdaterApi,
  readDismissedUpdateVersion,
  shellUpdateNotice,
  shouldShowUpdaterToast,
  updateTitle,
  writeDismissedUpdateVersion,
  type UpdaterStatus,
} from '@/lib/updater';
import { SidebarUpdateBanner } from './Shared/SidebarUpdateBanner';
import { startUpdateChecks } from '@/lib/shell/updateCheckSchedule';
import { whenDevInstallKnown } from '@/hooks/useDevInstall';
import { getVersion } from '@/lib/shell/app';

export function UpdaterToast() {
  const tr = useT();
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState<boolean>(false);
  // Closing the banner has to outlive the next status event, or it means
  // nothing: read the last dismissed version once, keep it in state so the
  // click takes effect without a reload. See shouldShowUpdaterToast.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    readDismissedUpdateVersion(),
  );
  // While the VersionPopover is open it OWNS the update surface: it anchors to
  // the same version chip and carries the full check/download/install flow, so
  // this toast rendering too stacked two update cards on top of each other
  // ("due modali una nell'altra", reported live 2026-07-11) — every status
  // change re-un-dismisses the toast, including the ones the popover's own
  // buttons cause. Suppress the toast while the popover reports itself open.
  const [versionPopoverOpen, setVersionPopoverOpen] = useState(false);
  // The two facts the sentence needs besides the offered version: which shell
  // is installed (the number an update actually replaces) and whether this is
  // the machine that builds the app. See `shellUpdateNotice`.
  const [shellVersion, setShellVersion] = useState('');
  const [devInstall, setDevInstall] = useState(false);
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
    // AND THEN IT LOOKS AGAIN, on every install, this one included. The boot
    // check alone is enough for an app that gets restarted; Topics is a login
    // item that stays open for days, so that single check was everything that
    // ever happened. The repeat, and the measurement that removed the dev
    // exemption from it, live in `lib/shell/updateCheckSchedule.ts`.
    //
    // What the dev answer decides now is the SENTENCE, not the silence: on the
    // machine that builds the app the banner has to name the installed shell,
    // which is the number that is really behind, instead of the release number
    // that the hot-delivered client bundle already matches (`shellUpdateNotice`).
    let alive = true;
    void getVersion().then((v) => { if (alive && v) setShellVersion(v); }).catch(() => {});
    void whenDevInstallKnown().then((known) => {
      if (!alive) return;
      setDevInstall(known);
    });
    // The host remembers the last outcome: a download left half-done, or a
    // build already waiting for a restart, has to be visible without waiting
    // for the next check.
    api.status().then(setStatus).catch(() => {});
    const stopChecks = startUpdateChecks(() => {
      api.checkForUpdates({ silent: true }).catch(() => {});
    });

    // Native menu "Controlla aggiornamenti…" (Tauri) dispatches this DOM event.
    const onMenuCheck = () => { api.checkForUpdates().catch(() => {}); };
    window.addEventListener('topics:check-for-updates', onMenuCheck);

    return () => {
      alive = false;
      off?.();
      stopChecks();
      window.removeEventListener('topics:check-for-updates', onMenuCheck);
    };
  }, []);

  // (Qui stava un listener di `resize` che ri-renderizzava il toast per
  // ricalcolare la sua posizione ancorata. Il banner adesso sta NEL FLUSSO
  // della sidebar: la larghezza gliela dà il layout, e non c'è nessuna
  // geometria da rileggere a mano.)

  if (!shouldShowUpdaterToast(status, { dismissed, versionPopoverOpen, dismissedVersion })) return null;

  // AN AVAILABLE UPDATE IS THE ONE STATE THAT NEEDS A SECOND NUMBER, so it gets
  // its own sentence: `shellUpdateNotice` weighs the offered version against
  // the shell that is actually installed and answers null when there is nothing
  // to announce. Every other state (checking, downloading, ready, error) speaks
  // about itself and keeps `updateTitle`.
  const notice = status.state === 'update-available'
    ? shellUpdateNotice(status.version, shellVersion, { devInstall })
    : null;
  if (status.state === 'update-available' && !notice) return null;

  const isReady = status.state === 'ready';
  const isError = status.state === 'error';

  // Il TITOLO in una riga, e il numero di versione dentro quando c'è: è
  // l'informazione che distingue questo avviso dall'altro (il bundle
  // ricostruito) e prima non compariva da nessuna parte.
  // The sentence itself comes from `updateTitle`, which is where the error is
  // turned into a key instead of being bolded verbatim.
  const heading = notice?.title ?? updateTitle(status);
  const title = tr(heading.key, heading.params);
  const detail = notice?.detail;

  return (
    <SidebarUpdateBanner
      kind="release"
      testId="updater-toast"
      tone={isReady ? 'ready' : isError ? 'error' : 'neutral'}
      icon={
        status.state === 'checking' ? <RefreshCw size={14} className="animate-spin" />
        : (status.state === 'update-available' || status.state === 'downloading') ? <Download size={14} />
        : (isReady || status.state === 'up-to-date') ? <Check size={14} />
        : isError ? <AlertCircle size={14} /> : null
      }
      title={title}
      // Sticky on ready: no close button. Otherwise allow dismiss.
      onDismiss={
        isReady
          ? undefined
          : () => {
              setDismissed(true);
              // On an available update the gesture also names the version, so
              // the next check does not undo it.
              if (status.state === 'update-available' && status.version) {
                writeDismissedUpdateVersion(status.version);
                setDismissedVersion(status.version);
              }
            }
      }
    >
      {detail && (
        // THE SECOND NUMBER, on its own line. The title is one line and it
        // truncates at the sidebar's real width: a headline carrying both
        // versions came back from the bench cut in half, mid-number.
        <div className="text-app-text-secondary tabular-nums" data-testid="updater-toast-detail">
          {tr(detail.key, detail.params)}
        </div>
      )}
      {status.state === 'update-available' && (
        <button
          onClick={async () => {
            // ONE BUTTON, because there is one action: the shell downloads and
            // installs in the same call. Two buttons described a two-step flow
            // the host never had.
            const api = getUpdaterApi();
            await (api?.downloadUpdate ? api.downloadUpdate() : api?.quitAndInstall());
          }}
          className="mt-1 text-app-text underline underline-offset-2 hover:no-underline"
        >
          {/* The verb is what tells the two sidebar notices apart: this one
              updates the shell, the other reloads the client bundle. The
              version popover keeps the longer "download and install" - it has
              the room, and it is not standing next to the other one. */}
          {tr('update.updateApp')}
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

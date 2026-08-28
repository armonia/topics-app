/**
 * Accesso condiviso all'updater della shell: su Tauri adatta i comandi Rust
 * `updater_check`/`updater_install` alla forma consumata da UpdaterToast e
 * VersionPopover; su web ritorna `undefined` e il chiamante disegna il proprio
 * fallback.
 *
 * [Il docblock precedente descriveva un bridge IPC di `electron-app/main.ts` e
 * la narrowing del tipo globale `electronAPI`: quel guscio è stato archiviato
 * nella v2.0.0 e quel global non esiste più. Il nome `ElectronUpdater` qui
 * sotto NON è un residuo — è tenuto apposta, e il perché è scritto dove viene
 * dichiarato.]
 */
import { useEffect, useState } from 'react';
import { isTauri } from './shell/index';
import { tauriInvoke } from './shell/tauri';

export interface UpdaterStatus {
  state: 'idle' | 'checking' | 'update-available' | 'downloading' | 'ready' | 'error';
  progress?: number;
  error?: string;
  /** Version string of the pending update, when the main process reports it. */
  version?: string;
  /** Esito di un controllo SILENZIOSO (quello automatico al boot): il toast non
   *  lo disegna. Vale solo per gli esiti che non chiedono niente all'utente —
   *  "sei aggiornato" e gli errori di rete/endpoint. Un aggiornamento DISPONIBILE
   *  esce sempre, anche se il controllo era silenzioso. */
  silent?: boolean;
}

/**
 * Il toast dell'updater si disegna?
 *
 * Pura di proposito: la regola è piccola ma ha quattro modi di sbagliarsi, e
 * l'unico posto dove viveva era una `return null` in mezzo a un componente —
 * non verificabile senza montare la UI. Qui è una tabella di verità.
 */
export function shouldShowUpdaterToast(
  status: UpdaterStatus,
  opts: { dismissed: boolean; versionPopoverOpen: boolean; dismissedVersion?: string | null },
): boolean {
  if (status.state === 'idle') return false;      // niente da dire
  if (opts.dismissed) return false;               // l'utente l'ha chiuso
  if (opts.versionPopoverOpen) return false;      // lo direbbe due volte
  if (status.silent) return false;                // esito di un controllo al boot
  // "x" HAS TO MEAN SOMETHING LONGER THAN FOUR SECONDS.
  //
  // Reported live 2026-08-27, twice, in these words:
  //   "mi dice ANCORA nuova versione v2.2.200 disponibile"  allow-italian: the
  //   report is the subject of the rule; the word carrying it means "still".
  // The banner was right - that version existed and the machine was 23 behind -
  // but closing it bought nothing. Every launch runs a check
  // ~4s in, an available update is published non-silent by design (see the
  // adapter), and the component's own listener resets `dismissed` on every
  // status event. Dismissal was therefore scoped to a status change, i.e. to
  // almost nothing.
  //
  // The fix is not to hide the update: that rule lived here once and was
  // removed for a good reason, written out below. It is to give the close
  // button the meaning a person reads into it - "not THIS version" - and let a
  // genuinely newer one speak again.
  if (
    status.state === 'update-available' &&
    !!status.version &&
    status.version === opts.dismissedVersion
  ) return false;
  // AN `autoUpdate` SUPPRESSION USED TO LIVE HERE, and its own last test said
  // why it had to go: "la regola vale solo dove l'aggiornamento arriva davvero
  // da se'". allow-italian: the removed rule's words are the argument for
  // removing it. It no longer arrives by itself. The shell installs and
  // relaunches on its own only while the main window is hidden
  // (may_relaunch_unattended in desktop-tauri), which is exactly when this toast
  // is not on screen to be suppressed. So the branch could only ever fire in the
  // case it was not written for: a visible window, an update that now waits for a
  // click, and an app with no way left to mention it.
  return true;
}

/** Where the dismissed version is remembered. Per browser profile, like every
 *  other "I have seen this" flag in the client. */
const DISMISSED_UPDATE_KEY = 'topics:updater:dismissed-version';

/** The version whose banner the user closed, or null. Never throws: a locked
 *  or unavailable storage means "nothing dismissed", which shows the banner -
 *  the safe side, because the update is real. */
export function readDismissedUpdateVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_UPDATE_KEY);
  } catch {
    return null;
  }
}

/** Remember (or, with null, forget) the closed version. */
export function writeDismissedUpdateVersion(version: string | null): void {
  try {
    if (version) window.localStorage.setItem(DISMISSED_UPDATE_KEY, version);
    else window.localStorage.removeItem(DISMISSED_UPDATE_KEY);
  } catch {
    /* storage unavailable: the banner comes back, which is the honest default */
  }
}

export interface ElectronUpdater {
  checkForUpdates: (options?: { silent?: boolean }) => Promise<{ ok: boolean; reason?: string }>;
  /** Explicit download trigger — required when `autoDownload: false` server-side. */
  downloadUpdate?: () => Promise<{ ok: boolean; reason?: string }>;
  status: () => Promise<UpdaterStatus>;
  quitAndInstall: () => Promise<{ ok: boolean; reason?: string }>;
  onStatus: (cb: (s: UpdaterStatus) => void) => () => void;
}

// ── Tauri updater adapter ──────────────────────────────────────────────────
// The Tauri shell has no event-driven `updater:*` IPC; it exposes two custom
// Rust commands (updater_check / updater_install — see desktop-tauri lib.rs).
// We adapt them to the same ElectronUpdater shape so UpdaterToast + VersionPopover
// work unchanged. Tauri's update is ATOMIC (download+install+restart in one call),
// so "download" is a no-op transition to `ready` and the real work runs on
// install. No progress events (would require @tauri-apps/api, which the shell
// deliberately avoids — see lib/shell/tauri.ts), so the bar stays indeterminate.
let tauriStatus: UpdaterStatus = { state: 'idle' };
const tauriListeners = new Set<(s: UpdaterStatus) => void>();
// Set when the Tauri ACL denies updater_check: this webview isn't the main
// window (browser panes load the client too and reach the IPC bridge, but
// their capability set excludes the updater). The updater then doesn't exist
// for this webview — every check becomes a silent no-op instead of an error
// toast the user can't act on (BRW-REL-03).
let tauriUpdaterDenied = false;
function isAclDenial(e: unknown): boolean {
  return /not allowed|acl/i.test(errText(e));
}
function setTauriStatus(next: UpdaterStatus): void {
  tauriStatus = next;
  for (const l of tauriListeners) { try { l(tauriStatus); } catch { /* listener threw — ignore */ } }
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
const tauriUpdater: ElectronUpdater = {
  async checkForUpdates(options) {
    if (tauriUpdaterDenied) return { ok: false, reason: 'updater unavailable in this webview' };
    const silent = options?.silent ?? false;
    // Un controllo silenzioso non annuncia nemmeno di essere in corso.
    if (!silent) setTauriStatus({ state: 'checking' });
    try {
      const info = await tauriInvoke<{ version: string } | null>('updater_check');
      // C'è davvero un aggiornamento: questo si vede SEMPRE, silenzioso o no.
      if (info) { setTauriStatus({ state: 'update-available', version: info.version, silent: false }); return { ok: true }; }
      setTauriStatus({ state: 'idle', silent });
      return { ok: true, reason: 'up-to-date' };
    } catch (e) {
      if (isAclDenial(e)) {
        tauriUpdaterDenied = true;
        setTauriStatus({ state: 'idle', silent });
        return { ok: false, reason: 'updater unavailable in this webview' };
      }
      setTauriStatus({ state: 'error', error: errText(e), silent });
      return { ok: false, reason: errText(e) };
    }
  },
  // Atomic on Tauri: just advance to `ready`; the real download runs on install.
  async downloadUpdate() {
    setTauriStatus({ state: 'ready' });
    return { ok: true };
  },
  async status() { return tauriStatus; },
  async quitAndInstall() {
    setTauriStatus({ state: 'downloading' });
    try {
      // Downloads, installs, then replaces the process — never resolves on success.
      await tauriInvoke('updater_install');
      setTauriStatus({ state: 'ready' });
      return { ok: true };
    } catch (e) {
      setTauriStatus({ state: 'error', error: errText(e) });
      return { ok: false, reason: errText(e) };
    }
  },
  onStatus(cb) { tauriListeners.add(cb); return () => { tauriListeners.delete(cb); }; },
};

export function getUpdaterApi(): ElectronUpdater | undefined {
  if (isTauri) return tauriUpdater;
  // Web has no native updater bridge (always-fresh); consumers show a web fallback.
  return undefined;
}

/**
 * Subscribe to updater status + expose the actions. `available` is false in web
 * mode (no Electron updater); consumers should show a web fallback then.
 */
export function useUpdater() {
  const api = getUpdaterApi();
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' });

  useEffect(() => {
    if (!api) return;
    api.status().then(setStatus).catch(() => {});
    return api.onStatus(setStatus);
  }, [api]);

  return {
    available: !!api,
    status,
    check: () => api?.checkForUpdates().catch(() => {}),
    download: () => (api?.downloadUpdate ? api.downloadUpdate() : api?.checkForUpdates())?.catch(() => {}),
    install: () => api?.quitAndInstall().catch(() => {}),
  };
}

/**
 * Shared access to the Electron auto-updater bridge (electron-app/main.ts
 * `updater:*` IPC). The global `electronAPI` type leaves `updater` under an
 * ad-hoc index signature, so we narrow it locally rather than widening window.
 * Returns `undefined` in web mode — callers render their own web fallback.
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
}

export interface ElectronUpdater {
  checkForUpdates: () => Promise<{ ok: boolean; reason?: string }>;
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
function setTauriStatus(next: UpdaterStatus): void {
  tauriStatus = next;
  for (const l of tauriListeners) { try { l(tauriStatus); } catch { /* listener threw — ignore */ } }
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
const tauriUpdater: ElectronUpdater = {
  async checkForUpdates() {
    setTauriStatus({ state: 'checking' });
    try {
      const info = await tauriInvoke<{ version: string } | null>('updater_check');
      if (info) { setTauriStatus({ state: 'update-available', version: info.version }); return { ok: true }; }
      setTauriStatus({ state: 'idle' });
      return { ok: true, reason: 'up-to-date' };
    } catch (e) {
      setTauriStatus({ state: 'error', error: errText(e) });
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
  const api = window.electronAPI as { updater?: ElectronUpdater } | undefined;
  return api?.updater;
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

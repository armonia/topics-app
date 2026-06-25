/**
 * Shared access to the Electron auto-updater bridge (electron-app/main.ts
 * `updater:*` IPC). The global `electronAPI` type leaves `updater` under an
 * ad-hoc index signature, so we narrow it locally rather than widening window.
 * Returns `undefined` in web mode — callers render their own web fallback.
 */
import { useEffect, useState } from 'react';

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

export function getUpdaterApi(): ElectronUpdater | undefined {
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

// App lifecycle + external-link capabilities, unified across Electron / Tauri / web.
// PORTING-PLAN.md §5b. Callsites import from here instead of branching on the host.

import { shellKind } from './index';
import { tauriInvoke } from './tauri';

interface ElectronApp {
  relaunch?(): Promise<void>;
  getVersion?(): Promise<string>;
}
function electronApp(): ElectronApp | undefined {
  return (window as unknown as { electronAPI?: { app?: ElectronApp } }).electronAPI?.app;
}

/** Open a URL in the user's default browser (never inside the app shell). */
export async function openExternal(url: string): Promise<void> {
  switch (shellKind) {
    case 'electron': {
      const api = (window as unknown as { electronAPI?: { openExternal?(u: string): void } }).electronAPI;
      if (api?.openExternal) { api.openExternal(url); return; }
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    case 'tauri':
      // tauri-plugin-opener
      await tauriInvoke('plugin:opener|open_url', { url });
      return;
    default:
      window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** Hard-restart the desktop app (bypasses the service worker). No-op on web. */
export async function relaunch(): Promise<void> {
  switch (shellKind) {
    case 'electron':
      await electronApp()?.relaunch?.();
      return;
    case 'tauri':
      // tauri-plugin-process
      await tauriInvoke('plugin:process|restart');
      return;
    default:
      window.location.reload();
  }
}

/** App version string. Falls back to the build-time version on web. */
export async function getVersion(): Promise<string> {
  switch (shellKind) {
    case 'electron':
      return (await electronApp()?.getVersion?.()) ?? buildVersion();
    case 'tauri':
      try {
        return await tauriInvoke<string>('plugin:app|version');
      } catch {
        return buildVersion();
      }
    default:
      return buildVersion();
  }
}

// Version baked at build time by Vite (`define.__APP_VERSION__`, from
// electron-app/package.json). Guarded so it's safe if the define is absent.
declare const __APP_VERSION__: string;
function buildVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
}

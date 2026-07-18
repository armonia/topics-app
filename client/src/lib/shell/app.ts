// App lifecycle + external-link capabilities, unified across Electron / Tauri / web.
// PORTING-PLAN.md §5b. Callsites import from here instead of branching on the host.

import { shellKind } from './index';
import { tauriInvoke } from './tauri';
import { openTaskInApp } from '../openTaskLink';

/** Open a URL in the user's default browser (never inside the app shell). */
export async function openExternal(url: string): Promise<void> {
  switch (shellKind) {
    case 'tauri':
      // tauri-plugin-opener
      await tauriInvoke('plugin:opener|open_url', { url });
      return;
    default:
      window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** Native folder picker — returns the chosen directory path, or null if the user
 *  cancelled. No-op (null) on web/PWA where there's no OS dialog. */
export async function selectDirectory(): Promise<string | null> {
  switch (shellKind) {
    case 'tauri': {
      // tauri-plugin-dialog: open({ directory: true }) → string | string[] | null.
      const sel = await tauriInvoke<string | string[] | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: 'Apri / Crea progetto' },
      });
      return typeof sel === 'string' ? sel : null;
    }
    default:
      return null;
  }
}

/**
 * Fire a native OS notification (completion / idle banners), unified across hosts.
 *
 * Returns true iff a banner was posted SYNCHRONOUSLY (Electron renderer / web, via
 * the permission-gated web Notification API) so the caller can drop a redundant
 * in-app toast. Tauri routes through the native `notify` command — WKWebView's web
 * Notification API is unreliable — fire-and-forget, and returns FALSE: delivery
 * can't be confirmed synchronously, so the caller keeps its in-app fallback as a
 * guarantee (you still get the native banner too when permission is granted).
 * Never throws — a denied permission or locked-down env just means no banner.
 */
export function notifyNative(
  title: string,
  body: string,
  opts?: { silent?: boolean; tag?: string; taskId?: string },
): boolean {
  if (shellKind === 'tauri') {
    // taskId rides into the native notification's userInfo; the Rust delegate
    // reads it back on click and emits `open-task` → the client opens the drawer
    // (see the listener in App). null when the banner isn't task-bound.
    void tauriInvoke('notify', { title, body, taskId: opts?.taskId ?? null });
    return false;
  }
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    const n = new Notification(title, { body, silent: opts?.silent, tag: opts?.tag });
    // Click a task-bound banner → focus the app and open that task's drawer.
    if (opts?.taskId) {
      const taskId = opts.taskId;
      n.onclick = () => {
        try { window.focus(); } catch { /* focus may be blocked — the deep-link still opens */ }
        openTaskInApp({ taskId });
        n.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}

/** Hard-restart the desktop app (bypasses the service worker). No-op on web. */
export async function relaunch(): Promise<void> {
  switch (shellKind) {
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

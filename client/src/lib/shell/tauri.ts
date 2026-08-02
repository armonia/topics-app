// Raw Tauri IPC helper — calls commands WITHOUT pulling in the @tauri-apps/* npm
// packages, so the Electron/web client bundle is unchanged. Tauri v2 always
// injects `window.__TAURI_INTERNALS__.invoke`. Built-in plugin commands are
// addressed by their internal name, e.g. `plugin:opener|open_url`.

interface TauriInternals {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  metadata?: { currentWindow?: { label?: string } };
}

function internals(): TauriInternals | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

/** The current Tauri window's label ("main" or "detach-…"), or null off Tauri.
 *  Tauri v2 injects it on `__TAURI_INTERNALS__.metadata.currentWindow`. Used by
 *  the cross-window presence channel so a detached window can advertise the
 *  label peers pass to `window_focus_label`. */
export function currentWindowLabel(): string | null {
  return internals()?.metadata?.currentWindow?.label ?? null;
}

/** Invoke a Tauri command. Throws if not running under Tauri. */
export function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const i = internals();
  if (!i) return Promise.reject(new Error('not running under Tauri'));
  return i.invoke<T>(cmd, args);
}

/** Tauri only — return AppKit first-responder to the main webview (the React
 *  chrome). A native browser pane is a sibling WKWebView that can hold keyboard
 *  first-responder; without handing it back, switching tabs can feel like the
 *  click/focus is "stuck" in the pane. Fire-and-forget; no-op off Tauri. */
export function releaseNativeFocus(): void {
  if (!internals()) return;
  // Scoping the reclaim to THIS window: in un pop-out il first-responder va
  // restituito alla chrome del pop-out, non a `main` (vedi browser_release_focus
  // in lib.rs). Bundle vecchi ignoravano l'arg → main, comportamento invariato.
  void tauriInvoke('browser_release_focus', { windowLabel: currentWindowLabel() ?? 'main' }).catch(() => {});
}

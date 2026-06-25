// Raw Tauri IPC helper — calls commands WITHOUT pulling in the @tauri-apps/* npm
// packages, so the Electron/web client bundle is unchanged. Tauri v2 always
// injects `window.__TAURI_INTERNALS__.invoke`. Built-in plugin commands are
// addressed by their internal name, e.g. `plugin:opener|open_url`.

interface TauriInternals {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

function internals(): TauriInternals | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

/** Invoke a Tauri command. Throws if not running under Tauri. */
export function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const i = internals();
  if (!i) return Promise.reject(new Error('not running under Tauri'));
  return i.invoke<T>(cmd, args);
}

export function hasTauri(): boolean {
  return internals() !== null;
}

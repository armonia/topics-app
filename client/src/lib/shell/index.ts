// Shell bridge — single abstraction over the host environment.
//
// PORTING-PLAN.md Tier 1 (T1.1): the client today reaches the desktop host via
// `window.electronAPI` in ~22 files. To swap Electron → Tauri without touching
// every callsite, those callsites route through this facade instead. Today every
// branch delegates to `window.electronAPI` (Electron) or no-ops (web/PWA); the
// Tauri branch is filled in during T1.2 using the plugins listed in the
// capability map (PORTING-PLAN.md §5b).
//
// This file is ADDITIVE and currently imported by nobody — it changes no runtime
// behaviour until callsites migrate. Migration is incremental and reversible.

export type ShellKind = 'electron' | 'tauri' | 'web';

declare global {
  interface Window {
    // Tauri v2 injects these globals when running inside the native shell.
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

/** Detect the host environment at runtime. Tauri exposes `__TAURI_INTERNALS__`
 *  (v2) / `__TAURI__` (v1 compat); everything else is plain web/PWA. The
 *  'electron' kind is retained in the type for legacy callsites but is never
 *  produced — the archived Electron shell no longer ships (v2.0.0). */
export function detectShell(): ShellKind {
  if (typeof window === 'undefined') return 'web';
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) return 'tauri';
  // Origin fallback (CRITICAL): Tauri injects its IPC globals at document-start,
  // but on the custom protocol that injection can land AFTER this module graph
  // evaluates — and because `shellKind` is a module-load constant, a single late
  // injection pins it to 'web' for the whole session, silently killing every
  // `isTauri`-gated feature (per-region vibrancy, platform label, native overlay)
  // while call-time `tauriInvoke` still works (perf/notifications). The webview's
  // ORIGIN is authoritative and available synchronously: tauri://localhost on
  // macOS, http://tauri.localhost on Windows/Linux.
  try {
    if (typeof location !== 'undefined') {
      if (location.protocol === 'tauri:') return 'tauri';
      const host = location.hostname || '';
      if (host === 'tauri.localhost' || host.endsWith('.tauri.localhost')) return 'tauri';
    }
  } catch { /* location unavailable — fall through */ }
  return 'web';
}

export const shellKind: ShellKind = detectShell();
// isElectron e il probe `capabilities` (nativeBrowser/nativeTerminal/nativeOverlay/
// perfMetrics/autoUpdate) sono stati rimossi: nessun callsite li importava — i
// branch desktop-vs-web nel resto del client discriminano già con isTauri/isDesktop.
export const isTauri = shellKind === 'tauri';
export const isDesktop = shellKind !== 'web';

// Shell bridge — facade unica sull'ambiente ospite.
//
// Riconosce Tauri a runtime (globali `__TAURI_INTERNALS__`/`__TAURI__`, con
// l'origine `tauri:` come fallback autorevole — vedi il commento CRITICAL in
// `detectShell`), altrimenti web/PWA. Espone `shellKind`, `isTauri`,
// `isDesktop` ed è importata da 18 callsite: è la porta da cui il client parla
// con l'host, non un file in attesa di essere cablato.
//
// [Nota storica, perché l'intestazione precedente diceva il contrario e per
// molto tempo nessuno l'ha riletta: questa facade è nata per il porting
// Electron → Tauri, quando ogni ramo delegava a `window.electronAPI` e il file
// non era ancora importato da nessuno. Electron è stato archiviato nella
// v2.0.0, `window.electronAPI` non esiste più, e i callsite sono migrati.]

/** The shells that actually exist. 'electron' was a member until 2026-07-29
 *  even though `detectShell` has never been able to return it (the Electron
 *  shell was archived in v2.0.0) — a phantom variant that every `switch` had to
 *  pretend to handle and no exhaustiveness check could help with. */
export type ShellKind = 'tauri' | 'web';

declare global {
  interface Window {
    // Tauri v2 injects these globals when running inside the native shell.
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

/** Detect the host environment at runtime. Tauri exposes `__TAURI_INTERNALS__`
 *  (v2) / `__TAURI__` (v1 compat); everything else is plain web/PWA. */
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

/**
 * True only inside the Tauri shell ON WINDOWS: that is where the system frame is
 * gone and the app has to draw its own controls.
 *
 * It lives here and not next to the component that first needed it
 * (`WindowControls.tsx`) for the same reason `isTauri` does: it is a fact about
 * the SHELL, not about a screen, and any Windows-specific branch elsewhere will
 * want it. Exporting it from a file that also exports a component made React
 * Fast Refresh give up on that file — a full page reload on every edit — and
 * `react-refresh/only-export-components` said so as a lint error.
 *
 * `userAgentData.platform` is the modern way and `platform` the deprecated but
 * still present one: both are read because WebView2 exposes both, and relying on
 * a single one means being wrong on one of the two versions.
 */
export const isTauriWindows =
  isTauri &&
  typeof navigator !== 'undefined' &&
  /Win/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      '',
  );

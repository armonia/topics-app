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

/** Detect the host environment at runtime. Electron is detected first because
 *  the current production desktop is Electron; Tauri exposes `__TAURI_INTERNALS__`
 *  (v2) / `__TAURI__` (v1 compat); everything else is plain web/PWA. */
export function detectShell(): ShellKind {
  if (typeof window === 'undefined') return 'web';
  if (window.electronAPI) return 'electron';
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) return 'tauri';
  return 'web';
}

export const shellKind: ShellKind = detectShell();
export const isElectron = shellKind === 'electron';
export const isTauri = shellKind === 'tauri';
export const isDesktop = shellKind !== 'web';

/** Capability probe — lets feature code ask "can the host do X here?" instead of
 *  branching on `shellKind`. Browser panes + native pty are desktop-only and
 *  degrade to a fallback UI on web/mobile (PORTING-PLAN.md §2 parity matrix). */
export const capabilities = {
  /** Embedded browser pane. Electron has a real WebContentsView per pane; Tauri
   *  does NOT yet (the single-WKWebView shell renders a placeholder — see
   *  RemoteBrowserPanel; the native CEF pane is the post-Tier-1 "D1" decision),
   *  so it must report false here. */
  get nativeBrowser(): boolean {
    return Boolean(window?.electronAPI?.browserNative?.isAvailable);
  },
  /** Native pseudo-terminal (pty). Desktop only. */
  get nativeTerminal(): boolean {
    return isDesktop;
  },
  /** Native overlay menus/modals (Electron transparent window / Tauri webview). */
  get nativeOverlay(): boolean {
    return Boolean(window?.electronAPI?.overlay) || isTauri;
  },
  /** Per-process perf metrics (CPU/GPU/memory). Desktop only. */
  get perfMetrics(): boolean {
    return Boolean(window?.electronAPI?.perf) || isTauri;
  },
  /** Auto-update channel. Desktop only (web is always-fresh). */
  get autoUpdate(): boolean {
    return isDesktop;
  },
} as const;

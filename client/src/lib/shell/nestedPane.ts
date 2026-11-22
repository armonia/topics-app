// "Is this client running INSIDE a Topics browser pane?" — and, if so, it is a
// read-only mirror of the shared window state.
//
// Why it exists: a pane can point at the Topics server itself (e.g.
// http://127.0.0.1:13333/, or an iframe doing the same). That nested page boots
// a full client like any other, so every click inside it (open the Board from
// the sidebar...) used to PUT the tab layout to /api/ui-state; the server fans
// the write out over the WS and the REAL app opened the same tab.
//
// A mirror still READS the shared state (GET + WS hydrate stay as they are);
// it just never WRITES the window-state keys (pane store, project layouts,
// tombstones, task/topic browser layouts, sidebar). Its edits stay local.
// User settings and theme are deliberately NOT gated: a preference changed in
// the pane should hold everywhere.

declare global {
  interface Window {
    /** Set by the Tauri shell's CONSOLE_PROXY_JS (desktop-tauri browser_panes.rs),
     *  an initialization script injected into EVERY browser-pane page and never
     *  into the main app window. */
    __topicsConsoleInstalled?: boolean;
    /** Set by the landing demo boot script (client/src/demo/boot.ts). */
    __topicsDemo?: boolean;
  }
}

let cached: boolean | null = null;

function detect(): boolean {
  if (typeof window === 'undefined') return false;
  // The landing demo is a legitimate iframe with a stubbed server: not a mirror.
  if (window.__topicsDemo === true) return false;
  if (window.__topicsConsoleInstalled === true) return true;
  try {
    return window.self !== window.top;
  } catch {
    // Reading `top` across origins can throw: that only happens inside a frame.
    return true;
  }
}

/** True when this page is nested in a Topics browser pane (native pane or
 *  iframe). Computed once, at the first call (boot). */
export function isNestedInTopicsPane(): boolean {
  if (cached === null) cached = detect();
  return cached;
}

/** @internal Test-only: drop the cached answer so the next call re-reads the globals. */
export function __resetNestedPaneForTests(): void {
  cached = null;
}

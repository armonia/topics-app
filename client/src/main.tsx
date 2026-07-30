import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Phase 30 PANE-01: all pane-state bootstrap (legacy-storage hydration, the four
// persistence transports, and the 500 ms GET fallback) lives inside
// client/src/state/pane/. main.tsx is intentionally a thin shell.
import { bootstrapPaneStore } from './state/pane/bootstrap';
import { initWindowPresence } from './state/windowPresence';
import { installDesktopFetchShim } from './lib/shell/net';
import { capturePairingTokenFromUrl } from './lib/shell/pairing';

// LAN/PWA pairing (LAN-PAIR-01): capture a `?token=` launch param into storage
// and strip it from the address bar BEFORE any fetch/WS fires, so the first
// authenticated call carries the token and the bar is clean on first paint.
// No-op on desktop/loopback (never launched with a token).
capturePairingTokenFromUrl();

// Desktop shell (Tauri) serves the UI locally; rewrite relative API fetches to
// the data server origin BEFORE any bootstrap fetch fires. No-op off-desktop.
installDesktopFetchShim();

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element not found')
}

// Prevent browser default file drop behavior (navigating to file:// URL).
// Individual drop zones (e.g. FileExplorer) call e.preventDefault() themselves and
// handle the files — this global handler is a safety net for drops outside those zones.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Self-heal stale bundles. build:watch rebuilds /public with NEW content hashes
// and deletes the old chunks; a client still running against the OLD index (Mac
// app or iPhone PWA) references dead hashes, so lazy-loading a chunk (e.g. the
// browser pane) 404s and the pane shows broken/blank ("index non trovato"). On
// an actual dynamic-import failure, reload ONCE to pull the fresh index + hashes.
// Guarded (sessionStorage, 15s window) so a genuinely-missing chunk surfaces
// instead of looping. This is DELIBERATELY NARROW — not the blanket auto-reload
// removed in useServiceWorkerUpdate ("the app refreshes by itself"): it fires
// only on a real chunk 404, never on a routine SW update.
function reloadForStaleChunkOnce(): void {
  const KEY = 'topics:chunk-reload-at';
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 15000) return; // already retried → let the error show
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* no storage → still reload once */ }
  location.reload();
}
// Chromium/WKWebView: Vite fires this when a preloaded module 404s.
window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); reloadForStaleChunkOnce(); });
// Safari/iOS PWA (no vite:preloadError): match the dynamic-import failure text.
const DYN_IMPORT_FAIL = /dynamically imported module|module script failed|Importing a module|Failed to fetch dynamically/i;
window.addEventListener('error', (e) => { if (e.message && DYN_IMPORT_FAIL.test(e.message)) reloadForStaleChunkOnce(); });
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { message?: string } | string | undefined;
  const msg = typeof reason === 'string' ? reason : reason?.message ?? '';
  if (DYN_IMPORT_FAIL.test(msg)) reloadForStaleChunkOnce();
});

bootstrapPaneStore();
// Cross-window presence: subscribe the store to the WS frame bus so "open in
// another window" markers work from the first `presence:windows` snapshot.
initWindowPresence();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

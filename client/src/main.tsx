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

bootstrapPaneStore();
// Cross-window presence: subscribe the store to the WS frame bus so "open in
// another window" markers work from the first `presence:windows` snapshot.
initWindowPresence();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

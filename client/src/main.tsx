import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { OverlayHostApp } from './OverlayHost'

// Phase 30 PANE-01: all pane-state bootstrap (legacy-storage hydration, the four
// persistence transports, and the 500 ms GET fallback) lives inside
// client/src/state/pane/. main.tsx is intentionally a thin shell.
import { bootstrapPaneStore } from './state/pane/bootstrap';

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element not found')
}

// Overlay-host window (electron-app/overlay-host.ts loads the app with
// `?overlay=1`): render ONLY the modal layer above the native browser. No
// pane-store bootstrap, no global drop handlers, no app shell — and a fully
// transparent page so the BrowserWindow shows the browser/desktop behind.
const isOverlay = new URLSearchParams(window.location.search).get('overlay') === '1';

if (isOverlay) {
  document.documentElement.style.setProperty('background', 'transparent', 'important');
  document.body.style.setProperty('background', 'transparent', 'important');
  createRoot(container).render(
    <StrictMode>
      <OverlayHostApp />
    </StrictMode>,
  );
} else {
  // Prevent Electron/browser default file drop behavior (navigating to file:// URL).
  // Individual drop zones (e.g. FileExplorer) call e.preventDefault() themselves and
  // handle the files — this global handler is a safety net for drops outside those zones.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  bootstrapPaneStore();

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

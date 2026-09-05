import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Phase 30 PANE-01: all pane-state bootstrap (legacy-storage hydration, the four
// persistence transports, and the 500 ms GET fallback) lives inside
// client/src/state/pane/. main.tsx is intentionally a thin shell.
import { bootstrapPaneStore, paneChunksWarm } from './state/pane/bootstrap';
import { awaitWithCap, FIRST_FRAME_WARM_CAP_MS } from './lib/firstFrameGate';
import { initWindowPresence } from './state/windowPresence';
import { installNetShim } from './lib/shell/net';
import { isInternalDrag } from './lib/dndTypes';
import { installPaneDragFlag } from './lib/paneDragFlag';
import { SessionRoot } from './components/Share/SessionRoot';

// Shim di rete: sotto Tauri riscrive le fetch relative verso l'origine del data
// server. Deve girare prima di ogni fetch di bootstrap. Su web non si installa —
// lì l'URL relativo è già quello giusto.
installNetShim();

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element not found')
}

// Prevent browser default file drop behavior (navigating to file:// URL).
// Individual drop zones (e.g. FileExplorer) call e.preventDefault() themselves and
// handle the files — this global handler is a safety net for drops outside those zones.
//
// Ma SOLO per ciò che arriva da fuori. Sul `dragover`, `preventDefault` non è
// una difesa: è il modo in cui una zona dichiara «qui si può lasciare». Steso
// sul documento diceva di sì da ogni pixel — cursore di spostamento anche sopra
// i posti che il drop rifiutava, e nessun modo per una zona di dire «qui no»,
// perché il suo silenzio veniva coperto un livello più su. Le nostre trascinate
// se le vedono le zone; vedi `isInternalDrag`.
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer && isInternalDrag(e.dataTransfer.types)) return;
  e.preventDefault();
});
// Il `drop` resta coperto senza eccezioni: qui `preventDefault` non promette
// niente a nessuno, toglie solo la navigazione. E per una trascinata nostra non
// arriva nemmeno — il browser emette `drop` solo dove il `dragover` ha detto sì.
document.addEventListener('drop', (e) => e.preventDefault());

// Mentre una TAB è in volo, gli iframe delle pane browser diventano trasparenti
// ai puntatori: senza, l'iframe si mangia il `dragover` e lasciare un browser
// sopra un altro browser non raggruppa niente. Vedi `lib/paneDragFlag`.
installPaneDragFlag();

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

const root = createRoot(container);
// The first frame waits for the chunks of the panes on screen, up to a cap: a
// cached chunk still settles in a later task than React's first render, and
// rendering before it paints a spinner per tile that the real body replaces a
// frame later. A complete frame a few dozen milliseconds later is the gesture
// a reload owes the reader; past the cap the app renders anyway and the
// suspense boundaries report what is missing. See `lib/firstFrameGate`.
void awaitWithCap(paneChunksWarm(), FIRST_FRAME_WARM_CAP_MS).then(() => {
  root.render(
    <StrictMode>
      {/* Chi entra decide COSA si monta. Un ospite non deve far partire l'app
          sotto una schermata che lo copre: ogni suo pezzo chiederebbe al server
          cose che il gate nega, e il risultato è una pagina di errori. */}
      <SessionRoot>
        <App />
      </SessionRoot>
    </StrictMode>,
  );
});

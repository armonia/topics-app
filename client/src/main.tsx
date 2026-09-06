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

// A CHUNK THAT DOES NOT LOAD IS THE BOUNDARY'S BUSINESS, not this file's.
//
// There used to be a "self-heal" here: on `vite:preloadError` (and on the
// matching `error` / `unhandledrejection` texts) the page called
// `location.reload()` once, behind a 15 s sessionStorage guard, to pull a fresh
// index after a rebuild had deleted the old hashes. Two things made it wrong
// once the pane bodies became lazy chunks with their own error boundary:
//
//  - the handler called `e.preventDefault()`, and for Vite's preload helper
//    that means "do not rethrow": the `import()` RESOLVED with `undefined`, the
//    lazy factory read `.DashboardPane` off it, and what reached the pane's
//    boundary was a TypeError about `undefined` instead of the fetch failure.
//    `isChunkLoadError` could not recognise it, so the boundary drew the
//    generic "try again" instead of the stale-bundle screen with its
//    cache-busted reload, and `warm` remembered `undefined` as a module.
//  - the reload itself took every pane down for the failure of one - attached
//    terminals, streaming chats, native browser views - which is exactly what
//    `PaneKeepAlive`'s boundary exists to prevent; and since the chunks of the
//    open panes are asked for BEFORE the first render (`panePreload`), a missing
//    one fired the reload at boot, before anything had been drawn.
//
// The stale-bundle case is handled where the error lands: the boundary
// classifies it (`crash.staleBundle`) and offers `reloadForNewBundle`, and
// `chunkReloadGuard` raises the DevBundleToast from the same three events.
// The user reloads; nothing reloads under the user.

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

# Engine switch — attivazione (drop-in) — task 54601eeb

Le **fondamenta** sono consegnate, testate e **inerti sul server live** (il registry
non è importato da `server.ts`, il sidecar non lancia nulla finché un pane non
acquisisce l'engine chromium):

- `server/browser-chromium-sidecar.ts` — discovery cross-platform + processo
  sidecar ref-counted/single-flight/idle-reap (DI per i test).
- `server/browser-chromium-extensions.ts` — discovery delle estensioni Chrome/Dia
  installate (42 reali su questo Mac).
- `server/browser-engine-registry.ts` — mappa `contextId → engine` con
  acquire/release; il singleton `chromiumSidecar` è cablato con
  `loadExtensions: () => discoverInstalledExtensions().map(e => e.path)` → **Opzione 1**
  (codice estensioni nel profilo dedicato persistente, l'utente si logga una volta).
- Test: 69 unit verdi (sidecar 11, registry 8, extensions 5, +…), tsc server 0.

## Cosa resta (LIVE — richiede un Chromium reale + app Tauri per costruire E verificare)

Va fatto con l'ambiente vivo perché lo streaming di un Chromium reale (finestra
headful, estensioni MV3) e il pane nativo WKWebView non sono costruibili/verificabili
headless. Passi, in ordine, dietro flag `TOPICS_CHROMIUM_ENGINE` (default off):

1. **browser-service: contesto su engine chromium.** Aggiungi a `createContext`
   `opts.engine?: 'default'|'chromium'` + `opts.cdpEndpoint?`. Su chromium usa un
   connettore iniettabile (default `pw.chromium.connectOverCDP(cdpEndpoint)`) invece
   di `ensureBrowser()`; usa il context di default del browser connesso
   (`browser.contexts()[0]`) dove vivono le estensioni; salta storageState/last-url
   (il profilo persistente del sidecar è la fonte). Su `destroyContext` fai
   `entry.engineBrowser.close()` (disconnette la CDP, NON killa il sidecar — il
   registry ne possiede il lifecycle). Lo screencast/dispatchInput esistenti girano
   invariati sul Page risultante (Playwright-astratto). *Verifica live*: aprendo un
   pane chromium devi vedere lo screenshot del Chromium reale con le estensioni.
2. **Route/WS set-engine.** Messaggio WS `set_engine` (client→server) o route REST →
   `browserEngineRegistry.setEngine(ctx, engine)` → ritorna `cdpEndpoint` →
   `destroyContext(ctx)` + `createContext(ctx, {engine, cdpEndpoint})` → broadcast
   dell'engine corrente al client. `release(ctx)` su close pane.
3. **Toggle client** nella `BrowserToolbar` (path WEB) + nel pane nativo Tauri:
   bottone engine (Native ↔ Chromium) che manda `set_engine`; su switch la pane si
   ricrea sull'engine scelto. Mostra un badge "Chromium · N estensioni".
4. **Pane nativo Tauri / Win-Linux (subtask #2)** + **nav via delegate nativo
   (subtask #3, elimina il poll 800ms)** — comandi Rust, richiedono la shell viva.

## Bivio già sciolto
Estensioni = **Opzione 1** (codice + profilo persistente, login manuale dell'utente
dentro il pane). L'Opzione 2 (profilo reale dell'utente) resta un possibile toggle
avanzato futuro (dà i login ma confligge col browser aperto sullo stesso profilo).

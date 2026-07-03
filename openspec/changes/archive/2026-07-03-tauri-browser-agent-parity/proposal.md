## Why

Su Tauri la **UI del browser** è a parità con Electron (navigate/back/forward/reload,
find, zoom, devtools, console badge, screenshot/freeze-frame, inspect, downloads,
bounds, lifecycle, shortcut, cronologia URL recenti). Il buco è concentrato nella
**gestione del browser da parte dell'AI**: l'utente ha chiesto esplicitamente di
migrare *"la gestione del browser da parte dell'ai"* e un audit (workflow 13 agenti,
verificato in modo avversariale) mostra che **non è migrata**.

Catena attuale: su Tauri la WKWebView **non ha CDP** (su Electron l'agente guida il
`WebContentsView` via CDP :19333). I tool dell'agente vengono delegati al client su
`/ws/browser` → `executeNativeBrowserOp` (`client/src/lib/shell/tauriBrowserOps.ts`),
ma `NATIVE_SUPPORTED_OPS` mappa **solo 5 op su 13**: `browser_open`, `browser_eval`,
`browser_get_text` (intera pagina), `browser_console`, `browser_screenshot`. Le altre
8 ritornano un errore *"abilita streaming"*. Conseguenza: sul pane che l'utente
**vede**, l'agente **non** può `observe`/`act`/`extract` by-ref, fare vision
`read_screen`/`point`, né `save`/`load`/`import` dello stato di login. L'unica
alternativa (streaming) pilota un **Chromium separato** con profilo/login diversi —
non il pane nativo.

Il substrato per chiudere il gap c'è già: **`browser_eval` è delegato** e gira JS
arbitrario sulla WKWebView reale (`browser_eval_js` → Rust). Quindi observe/act/extract
sono implementabili **client-side**, senza CDP e senza Rust.

## What Changes

### Phase 1 — Agent DOM control sul pane nativo (HIGH, client-only)
- In `tauriBrowserOps.ts`, implementare `browser_observe`, `browser_act`,
  `browser_extract`, `browser_get_text(ref)` via un **walker DOM iniettato** (un solo
  `browser_eval_js`) che assegna ref in un registry in-page `window.__topicsRefs` e
  ritorna uno snapshot strutturato.
- L'executor deve **riprodurre le stesse shape** dei handler server
  (`handleBrowserObserve` → `{url,title,count,snapshot,full}`; `handleBrowserAct` →
  `{ok,action,ref,snapshot}`) e lo **stesso formato testuale serialize/diff** che
  l'agente è addestrato/promptato a parsare (`server/browser-tools-handler.ts`).
- `act` supporta `click/dblclick/hover/fill/type/select/check/uncheck/press/scroll/get_text`
  (eventi sintetizzati in JS; documentare il limite "non-trusted" vs CDP
  `Input.dispatch`).

### Phase 2 — Agent vision sul pane nativo (MED)
- Cablare `browser_read_screen` e `browser_point` allo `browser_screenshot` nativo
  **già esistente**: il dispatcher cattura lo screenshot delegato dal pane nativo e
  fa girare il layer vision esistente (Moondream `describeImage` / `point`)
  server-side, invece di ritornare l'hint streaming.

### Phase 3 — Portabilità login dell'agente sul pane nativo (MED)
- Nuovi comandi Rust che fanno da bridge a **`WKHTTPCookieStore`** (cookie) +
  `localStorage` via eval, per `browser_save_state` / `browser_load_state` /
  `browser_import_chrome` sul pane nativo.

### Phase 4 — Hardening navigazione/permessi del pane nativo (MED)
- **Scheme-guard per-pane** nel `nav-guard` di `lib.rs` (oggi i pane sono esenti →
  `window.location='file://'` via eval passa: LFI).
- **Permission delegate** WKWebView (camera/mic/geo) cablato alla `PermissionBar`
  esistente.
- **`window.open`/`window.close`** (analoghi di `CLOSE_SENTINEL` + `windowOpenHandler`)
  per i flussi OAuth/popup.
- Bridge **`WKBackForwardList`** così `getNavEntries` (oggi stub vuoto) popola il
  dropdown cronologia back/forward.

## Capabilities

### Added Capabilities
- `native-browser`: parità di **controllo agente** sul pane WKWebView nativo
  visibile — observe/act/extract/get_text(ref), vision read_screen/point,
  save/load/import dello stato di login — più hardening di navigazione e permessi.
  Vincolo trasversale: lo schema dei tool (`browser-tool-spec.ts`) resta
  **invariato**; pane nativo e streaming restano intercambiabili per il chiamante.

## Impact

- **Client**: `client/src/lib/shell/tauriBrowserOps.ts` (executor + walker + serialize/diff
  condivisi), `client/src/hooks/useTauriBrowser.ts` (handler WS + `getNavEntries`),
  `client/src/components/Browser/PermissionBar.tsx`. Richiede `vite build` → `/public`.
- **Server**: `server/browser-tool-dispatcher.ts` (Phase 2: vision sullo screenshot
  delegato). Applicare con `kickstart -k` di `com.armonia.topics-server` (no hot-reload
  su `server/`).
- **Rust/Tauri**: `desktop-tauri/src-tauri/src/lib.rs` (Phase 3 cookie bridge; Phase 4
  scheme-guard, permission delegate, window.open/close, nav-entries). Richiede rebuild
  del binario Tauri (debug per iterare, release per la build vera).
- **Tests**: `bun:test` per la logica pura dell'executor/walker e di serialize/diff
  (co-locati `*.test.ts`); Playwright E2E resta il default per i flussi UI.
- **Nessuna modifica** allo schema dei tool, alla modalità streaming/Playwright, o
  alla UI human-facing del browser (già a parità).

# Engine switch — attivazione — task 54601eeb

Stato: **attivo**. Il flag `TOPICS_CHROMIUM_ENGINE` è stato TOLTO il 04/08/2026: teneva spenta una funzione completa e collaudata, e la domanda giusta la sapeva già fare il codice — «c'è un Chromium installato?». Se non c'è, il bottone resta nascosto come prima.
Con la flag spenta tutto è inerte: il ramo WS `set_engine` risponde `native`, la
DELETE non rilascia ref, `/api/browsers/engines` ritorna `{enabled:false}`, il
client non mostra il toggle → nessun Chromium parte. Si accende impostando
`TOPICS_CHROMIUM_ENGINE=1` nell'ambiente del server (headful + Tauri).

## Cosa è FATTO (verificabile headless, testato)

- **Protocollo WS** (`browser-ws-messages.ts` + mirror): varianti `set_engine`
  (client→server) e `engine` (server→client, con `extensions` per il badge).
- **browser-service**: ramo engine `chromium` in `createContext` — connette al
  sidecar via `connectOverCDP` (iniettabile), riusa il **context condiviso** del
  sidecar (dove vivono le estensioni), cattura il targetId, niente
  storageState/last-url/cookie (il profilo persistente del sidecar è la fonte).
  `destroyContext`/`close` chiudono la pagina + disconnettono la CDP ma **mai** il
  context condiviso. `setEngineHint(id, engine, cdp)` consultato da `createContext`
  → lo switch è `hint → destroy → (client remount) → getOrCreate → ricrea su engine`.
- **Orchestrazione** (`browser-engine-switch.ts`, pura + DI): `applyEngineSwitch`
  = `registry.setEngine` (acquire/release del ref) → `setEngineHint` → `destroyContext`
  → messaggio `engine` da broadcastare.
- **server.ts**: ramo `set_engine` flag-gated → `applyEngineSwitch` + broadcast a
  tutti i viewer. **routes**: `GET /api/browsers/engines` (capability + conteggio
  estensioni), `release()` del ref sidecar sulla `DELETE /api/browsers/:id`.
- **client**: `useRemoteBrowser` con stato engine, `setEngine()`, handler del
  broadcast `engine` (badge + **remount del WS** via `engineEpoch` così il server
  ricrea il contesto sul nuovo engine), fetch della capability. Toggle
  `Native ↔ Chromium · N estensioni` in `RemoteBrowserPanel` (solo streaming).
- **Test**: unit — schema (15), engine service con fake CDP (4), switch puro (5),
  registry (8), sidecar (11), extensions discovery (5); E2E — `browser-engine-switch`
  (toggle nascosto se off; on → Nativo↔Chromium con remount). tsc client+server 0.

## Cosa RESTA (LIVE — richiede Chromium reale + verifica visiva)

1. **Accendi la flag nel server vivo** (`TOPICS_CHROMIUM_ENGINE=1`, headful) e apri
   una web-pane: clic sul toggle → devi VEDERE lo screenshot del Chromium reale con
   le tue estensioni caricate. Prima volta: login manuale nelle estensioni dentro
   il pane (Opzione 1 — profilo dedicato persistente, il login resta).
   *Non verificabile headless*: lo streaming di una finestra headful + estensioni MV3.
2. **Pane nativo Tauri / Win-Linux (subtask #2)** + **nav via delegate nativo
   (subtask #3, elimina il poll 800ms)** — comandi Rust, richiedono la shell viva.
   Ortogonali all'engine switch (riguardano il pane 'native' su altre piattaforme).

## Bivio già sciolto
Estensioni = **Opzione 1** (codice + profilo persistente, login manuale dell'utente
dentro il pane). L'Opzione 2 (profilo reale dell'utente) resta un toggle avanzato
futuro (dà i login ma confligge col browser aperto sullo stesso profilo).

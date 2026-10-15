# Tasks — browser-native-host-cobrowse

## Fase 0 — Overlay input (WKWebView-safe) ✅ FATTO
- [x] Spostare la cattura input dal sandboxed-iframe a un overlay nel frame principale
      (`DomCoBrowse.tsx`): pointer/click/contextmenu/wheel/touch → `mapCoordinates` (÷scale)
      → `sendInput`.
- [x] Tastiera via textarea nascosta sempre rifocalizzata: keydown (hardware) +
      `beforeinput`/composition nativo (soft-keyboard mobile, paste, IME) → relay.
- [x] Selezione testo locale on-demand: Option = toggle → overlay cede + mirror
      `enableInteract`, con nav-guard in-iframe.
- [x] e2e `browser-dom-cobrowse.spec.ts` aggiornata (overlay + toggle selezione): 3/3.
- [x] tsc + eslint verdi; bundle ricostruito; commit `ce871d1f`.

## Ricerca + spike (fondamenta) ✅ FATTO
- [x] Ricerca motore/ecosistema 2026 (Chromium/CDP, WebView2, WebKit-embed, Servo/Verso/
      Ladybird, BiDi) con fonti primarie.
- [x] Spike misura footprint + substrato: `spike/browser-engine/EVALUATION.md`
      (headless-shell vs full, screencast fps, input RTT). Riproducibile: `run-all.sh`.

## Fase 1 — Host nativo unificato (substrato DECISO: WKWebView + native-executor + cattura)
> Decisione 2026-07-21 su mappa del codice: NIENTE CEF. Compositing pane nativo,
> delega agente e encode/fan-out WebRTC esistono già. Unico mancante = cattura
> device-side del pane → bridge. Sequenza MVP-first:
- [x] **ANTICIPATO (commit `d7bcfd30`)** Flip del default desktop → **nativo**
      (`readSharedPref` in `RemoteBrowserPanel.tsx`). Motivo: la lentezza del mirror
      server è il dolore quotidiano ("va ancora troppo lento") e il pane nativo era
      già l'opt-out. Trade-off dichiarato: il cross-device live torna opt-in (toggle
      toolbar) finché la cattura non lo rende zero-compromessi. Migrazione pulita
      ('1'=shared storico, chiavi assenti flippano a nativo). tsc+eslint+e2e verdi.
- [ ] **(gated build shell)** MVP wiring: loop `takeSnapshot`→JPEG in `jpeg_tx` (`lib.rs`)
      per provare nativo→follower end-to-end a basso fps.
- [ ] **(verificabile qui)** Bridge sorgente-agnostico: re-key `get_or_create_target`/offer
      da CDP-targetId a paneId + ingresso producer JPEG accanto a `cdp::attach_and_stream`
      (`webrtc-bridge/src/{main.rs,cdp.rs}`); estendere `test-harness.mjs`; `cargo build`.
- [ ] **(live via kickstart)** Routing server: `webrtc_offer` → stream device-side quando
      `isDelegated(ctx)` (`server.ts:1660-1676`, `server/webrtc-bridge.ts`).
- [ ] **(gated build shell + TCC)** Cattura ScreenCaptureKit: nuovo modulo Rust `SCStream`
      sul pane → JPEG → bridge + flusso permesso screen-recording.
- [ ] Input back-channel follower→Mac (riuso `browser_act`; caveat `isTrusted=false`).
- [x] **FATTO in anticipo (`d7bcfd30`)** Flip `readSharedPref` → host nativo primario.
      (Il piano lo metteva DOPO la cattura per evitare divergenza; anticipato con
      tradeoff dichiarato — vedi la voce in cima alla Fase 1. La cattura lo renderà
      poi zero-compromessi anche col follower connesso.)
- [ ] Election promote/demote (device attivo=host, server=riserva); riusa la delega.
- [ ] Test: harness sidecar (frame device→viewer), unit routing/election, e2e default.

## Fase 2 — Trasporto follower (pixel + input)
- [ ] `webrtc-bridge` con **source = device host** (oltre al source server esistente).
- [ ] Superficie follower `<video>` che riusa l'overlay input della Fase 0.
- [ ] TURN oltre LAN; keyframe-on-join (già presente lato server) esteso al device-source.
- [ ] Test: fan-out N-viewer, input relay follower→host, latenza.

## Fase 3 — Portabilità sessione + sync
- [ ] Jar autoritativo server + handoff cookie/storage via CDP `getAllCookies`/`setCookies`.
- [ ] Sync cross-device tab/cronologia/preferiti/password (`yrs`/`automerge`).
- [ ] Test: handoff host senza re-login (caso comune); fallback re-auth lazy.

## Fase 4 — Superficie top-browser + cuneo AI (backlog)
- [ ] Omnibox, gestione tab, estensioni Chromium, autofill, download manager, reader, adblock.
- [ ] Agente che condivide la TUA tab cross-device (presence, view-only↔control, permessi).

## Attivazione / ambiente (richiede ok umano)
- [ ] Rebuild + relaunch guscio Tauri quando si tocca `lib.rs` (nav-guard/host/cattura):
      il binario installato è 2.1.119, indietro rispetto al sorgente 2.1.127.
- [ ] Seam BiDi: ri-valutare quando screencast/input BiDi maturano (Ladybird ~2028, Servo).

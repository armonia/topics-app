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

## Fase 1 — Host nativo Chromium + election + riserva server
- [ ] Spike integrazione: compositare una finestra Chromium gestita nel layout Tauri
      (CEF vs finestra esterna vs screencast-locale) → decisione + EVALUATION.
- [ ] `BrowserControl` seam (interfaccia unica CDP: navigate/screencast/input/cookies),
      impl `CDPControl` su **pipe** (host headful) e **port** (headless-shell).
- [ ] Host nativo on-device di default (flip `shared`): solo = nativo. `ungoogled-chromium`
      opzione device-host.
- [ ] Host-election: primo device attivo = host; server = riserva; promote/demote su
      join/leave/sleep; riusa `register_native_executor` per il drive dell'agente.
- [ ] Motore per ruolo: `chrome-headless-shell` per server/render-node; headful per host.
- [ ] Test: unit election (puro), e2e selezione host/fallback.

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

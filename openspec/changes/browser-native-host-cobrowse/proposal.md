# Proposal — browser-native-host-cobrowse

## Why

Topics deve diventare **il browser dell'utente**: una sola sessione live, nativa e
veloce quando sei da solo, condivisa e pilotabile su tutti i tuoi device (Mac app +
PWA iPhone) e dall'agente. L'architettura attuale non regge questo obiettivo per due
motivi strutturali, verificati sul codice e con misure dirette:

1. **Input desktop rotto (WKWebView).** Il co-browse rende la pagina server-side come
   mirror DOM (rrweb) dentro un iframe `sandbox="allow-same-origin"`. L'input veniva
   catturato DENTRO quell'iframe: su WKWebView + scheme `tauri://localhost` il
   `contentDocument` non è affidabilmente scriptabile e il `preventDefault` in-iframe
   viene ignorato → su Mac click e digitazione morivano mentre sul web (Blink)
   funzionavano. Il server non distingue nemmeno i client: input path identico
   byte-per-byte → la causa era 100% client-side/engine. **Risolto in Fase 0** (overlay
   di cattura nel frame principale, commit `ce871d1f`).

2. **Il mirror DOM non può essere il render primario di un browser vero.** Fisica, non
   polish: isole pixel (canvas/WebGL/`<video>`, peggio se DRM) non sopravvivono al
   mirror; ogni interazione è un round-trip; niente estensioni/autofill nativi; e un
   Chromium headless per tab per utente è costoso. Un browser che non fa girare YouTube
   a velocità nativa non è il browser primario di nessuno.

**Ricerca motore (2026, fonti primarie).** Il solo stack maturo per screencast + input
*trusted* + intercettazione di rete è **Chromium + CDP**. Ogni WebView nativa TRANNE
WebView2 (Windows) **rifiuta CDP** — WKWebView (mac) e WebKitGTK (linux) non lo
espongono: è il motivo tecnico definitivo per NON usare WKWebView come motore delle tab
in un prodotto pilotato da agente. Servo/Verso/Ladybird = *watch-only* (non daily
driver, niente CDP). WebDriver BiDi è la scommessa engine-agnostica giusta ma **non
ancora** (screencast/input nascenti, Safari assente).

**Misure dirette (spike `spike/browser-engine/`, macOS arm64, Chrome-for-Testing 148):**

| engine/mode | disco | avvio→CDP | RSS blank | RSS wikipedia | screencast fps | frame KB | input RTT |
|---|---|---|---|---|---|---|---|
| chrome-headless-shell | 190 MB | ~0.96 s | ~246 MB | 353–376 MB | 99 | 11.6 | ~1 ms |
| chromium `--headless=new` | 341 MB | 1.1–2.4 s | 650–710 MB | 733–838 MB | 99 | 11.7 | ~1.3 ms |
| chromium headful | 341 MB | ~1.1 s | ~708 MB | 832–837 MB | 100 | 11.6 | ~1.4 ms |

Conclusioni misurate: **Chromium+CDP è un substrato solido** (~1s avvio, 99fps
screencast, ~1ms input, tutto su un plain `--remote-debugging-port`). **headless-shell è
~2.7× più leggero in RAM e 1.8× su disco a parità di fps/latenza** → è la build giusta
per i nodi server/follower. Caveat di trasporto: il full Chrome-for-Testing **non bind-a
la porta TCP CDP** in questo ambiente → il full/headful va pilotato su **pipe
transport**; solo headless-shell usa la porta.

## What Changes

Si inverte chi è l'host di render, mantenendo la sessione condivisa come layer di
share/agente/sync (non di render):

- **Host dinamico.** Il device attivo/in-controllo è l'**host nativo** (Chromium
  gestito, reso localmente = scheggia, media veri). Da solo non trasmette. Il **server
  è l'host di riserva sempre pronto**: subentra quando nessun device è sveglio o quando
  l'agente gira headless → la tab non muore mai. L'iPhone (PWA) è di fatto sempre
  **follower** (non può catturare/streammare).
- **Follower = pixel + input relay.** Quando un secondo device guarda, l'host cattura
  via CDP screencast → **WebRTC H.264** (fan-out, il `webrtc-bridge` Rust esiste già) e
  i follower rimandano l'input con l'overlay della Fase 0. Media inclusi, niente isole
  nere (l'host renderizza nativo).
- **Motore Chromium per ruolo.** Device host = **Chromium headful gestito** (pipe
  transport; su Windows si può usare WebView2 per il runtime condiviso, con il caveat
  del regression CDP per processi elevati). Server + nodo di render follower =
  **chrome-headless-shell**. `ungoogled-chromium` come opzione device-host per tagliare
  la telemetria; **Thorium scartato** (bus-factor + security-lag).
- **Portabilità di sessione risolta dall'unificazione.** Con Chromium ovunque, l'handoff
  dell'host = copia cookie/storage via CDP `Network.getAllCookies`/`setCookies` (stesso
  formato device↔server); il **jar autoritativo vive lato server** come àncora. Era
  duro solo perché WKWebView(WebKit) ≠ Chromium.
- **CDP dietro un seam di control-plane** così un backend **WebDriver BiDi** potrà
  entrare quando i suoi moduli screencast/input maturano, senza toccare il codice
  prodotto.
- **Deprecazione.** WKWebView-come-tab e rrweb-mirror-come-render-primario escono dal
  percorso di default (il mirror resta come modalità/fallback, non il binario di tutti
  i giorni).

## Non-Goals

- **Motore web in Rust ora** (Servo/Verso/Ladybird): non pronti al web reale, niente
  CDP → osservare, non scommetterci. Rust resta per il layer sistemi (transport, sync,
  orchestrazione, encode, guscio), non per il motore.
- **Superficie "top browser" completa** (estensioni, autofill, password sync, adblock,
  reader): è la Fase 4, backlog a parte; questa proposta consegna la spina (Fasi 0-2) +
  la continuità di sessione (Fase 3).
- **P2P puro cross-rete senza server**: oltre la LAN serve signaling + TURN; la riserva
  server (scelta esplicita dell'utente) mantiene comunque un host sempre disponibile.
- **Migrazione del control-plane a BiDi** in questa proposta: si introduce solo il seam.

## Impact

- **Client**: `DomCoBrowse` (Fase 0, fatto), nuovo host nativo Chromium + selezione
  host/follower in `RemoteBrowserPanel`/`useRemoteBrowser`, superficie follower su
  `<video>` che riusa l'overlay.
- **Server**: motore per ruolo (headless-shell), broker di host-election, jar
  autoritativo + handoff cookie CDP, seam control-plane.
- **Rust**: `webrtc-bridge` ripuntato con source = device; guscio Tauri (host nativo,
  cattura). `desktop-tauri/src-tauri/src/lib.rs` nav-guard (già "deny", non più "apri in
  Dia" sul sorgente; il binario installato 2.1.119 è indietro → rebuild all'attivazione).
- **Capability**: estende `remote-browser`; introduce host-election, transport follower,
  session-portability.

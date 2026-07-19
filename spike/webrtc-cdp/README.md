# Spike — Browser a sessione condivisa via WebRTC-over-CDP (no docker, Rust)

Obiettivo: **stessa sessione browser live, condivisa Mac↔mobile**, a massime
performance, **senza docker** (niente neko). Riusa il Chromium headless già
spawnato dal server (`server/browser-service.ts`, CDP su :19222) e il fan-out
N-viewer già esistente (`startScreencast` → subscribers set).

## Architettura decisa

- **Un solo context server condiviso** per pane → Mac e mobile guardano LO STESSO
  browser (stessa sessione/login/cursore). Il fan-out c'è già.
- **Sidecar Rust WebRTC** (`webrtc-rs`) spawnato dal server come il PTY bridge
  (`desktop-tauri/pty-bridge/` = template: crate separato, `externalBin` Tauri,
  path via env `TOPICS_*_BIN`, unix socket NDJSON per il signaling).
- Il sidecar si aggancia al **CDP** (:19222), consuma i frame screencast, li
  **ricodifica H.264/HEVC via VideoToolbox** (HW encode su GPU Apple), li spedisce
  su una **WebRTC video track**. Input (click/scroll/tasti) su **DataChannel** →
  CDP `Input.dispatch*`.
- **Signaling** (SDP/ICE) brokerato sul WS `/ws/browser/:ctx` esistente (nuove
  varianti `webrtc-offer|answer|ice` nello schema Zod + mirror client).
- **Client = `<video>`** con la track remota: WKWebView (Mac) e Safari mobile
  parlano WebRTC nativo → zero rendering custom.
- **LAN/Tailscale**: `NAT1TO1` sull'IP locale → niente TURN, niente docker. Fuori
  LAN con NAT stretto: Coturn (binario, non container).

## Feasibility gate — MISURATO (2026-07-19)

`bun spike/webrtc-cdp/measure-fps.mjs [everyNthFrame]` — crea un target CDP usa-e-getta
(non tocca i context vivi di Topics), screencast su pagina animata, conta frame/sec.

| everyNthFrame | fps reali | KB/frame | bitrate JPEG |
|---|---|---|---|
| 1 (max) | **92.9 fps** | 6.3 | 4.8 Mbps |
| 2 (default attuale) | 46.5 fps | 6.3 | 2.4 Mbps |

**Verdetto: la sorgente NON è il collo di bottiglia.** I ~15fps di oggi sono
auto-imposti (`everyNthFrame:2` + throttle client), non un limite CDP. Retina
2560×1440 regge 90+fps. Il native-grade è raggiungibile; il valore di WebRTC+Rust
è il **transport**: stessi 60fps a ~10× meno banda (H.264 inter-frame) + HW encode
→ viabile su wifi/Tailscale verso mobile. La JPEG-over-WS a 4.8 Mbps non scala su
rete mobile; H.264 sì.

## Stage 1 — client CDP in Rust — FATTO e VERIFICATO (2026-07-19)

`bridge/` (crate `webrtc-cdp-bridge`, template pty-bridge): tokio + tokio-tungstenite.
Connette al CDP browser-ws, crea target usa-e-getta, attacca (flatten), `Page.enable` +
`setDeviceMetricsOverride` retina, naviga una pagina CSS-animata, avvia lo screencast e
consuma i frame **ack-gated**.

`cargo run --release -- [everyNthFrame] [durationMs]` (serve un Chromium su :19222).
**Esito: 60.2 fps (380 frame in 6.3s), 2.7 KB/frame, 1.3 Mbps** contro un Chromium
headless standalone — pari a Bun sulla stessa sorgente. La pipeline async CDP-in-Rust
regge il full-rate.

**Gotcha bruciati (documentati nel codice):**
- `Page.screencastFrameAck` **richiede** `params.sessionId` = l'**intero** della sessione
  screencast (dentro il frame), NON il sessionId CDP. Lo screencast è ack-gated: senza ack
  corretto Chrome sputa ~3 frame bufferizzati e si ferma. Il gate `.as_str()` su un intero
  dà None → ack mai inviato (il bug che dava "3 frame").
- `startScreencast` va lanciato **su un timer separato**, non dentro il read-loop (che
  bloccherebbe su `read.next()` aspettando un messaggio che non arriva).
- Il GET HTTP a `/json/version`: DevTools tiene la connessione keep-alive → `read_to_string`
  si appende; leggere per `Content-Length` con read-timeout.
- Frame continui: usa **animazioni CSS** (compositor) non `requestAnimationFrame` (throttlato
  offscreen in `--headless=new`).

## Stage 2 — transport WebRTC H.264 — FATTO e VERIFICATO END-TO-END (2026-07-19)

`main.rs` + `cdp.rs`: una CDP screencast → un encoder → **una** `TrackLocalStaticSample`
condivisa (webrtc-rs la fa a fan-out su N peer). Pipeline: CDP JPEG → decode (`zune-jpeg`)
→ I420 (`openh264` RgbSliceU8→YUVBuffer) → **H.264 openh264** → track → RTP/WebRTC. Signaling
= HTTP minimale fatto a mano (`GET /` = pagina `<video>` di test, `POST /offer` = SDP answer).

Validazione headless (`validate.mjs`, viewer Playwright che legge `getStats`):
```
ice=connected  video=756x412  framesDecoded=17  codec=video/H264  ✅ PASS
```
Prova visiva: `evidence-video.png` = il `<video>` del viewer mostra la pagina renderizzata
nel Chromium sorgente (titolo + cerchio animato), arrivata via H.264/WebRTC. La pagina
sorgente e il viewer sono processi/browser distinti → transport reale, non un iframe.

`cargo run --release -- [signalPort] [targetUrl]` (serve Chromium CDP su :19222).
`bun validate.mjs [url]` valida end-to-end.

**Gotcha bruciati (nel codice):**
- **ICE resta in `checking` con lo STUN pubblico** → in LAN/localhost bastano i candidate
  **host**: `RTCConfiguration::default()` (niente STUN) → `connected` subito. Lo STUN serve
  solo oltre-LAN (e lì serve TURN, non basta STUN).
- **`framesDecoded=0` ma i byte scorrono** = manca la keyframe per il viewer che entra dopo
  l'IDR iniziale. Fix: `encoder.force_intra_frame()` **periodico** (ogni ~30 frame ≈1s) — un
  solo encoder condiviso, ogni peer si sincronizza entro 1s. (Il "vero" fix di produzione è
  cablare RTCP-PLI → force_intra on-demand.)
- **`openh264::Encoder` è `!Send`** → NON può stare sul runtime async (niente `.await` mentre
  lo tieni). Vive su un **thread OS dedicato**; manda i sample H.264 a un task async che li
  scrive sulla track.
- Il Chromium sorgente headless standalone **muore durante le build lunghe** → rilancialo
  DOPO il `cargo build`, prima della validazione (il bridge ha un retry-loop sul CDP).

## Stage 3 — TODO: sharing
Il Mac usa il context server condiviso (engine "shared") invece della WKWebView nativa →
mobile joina lo stesso `contextId`.

## Ordine di build (due workstream ortogonali)

1. **Sharing** (abilita "stessa sessione"): il Mac usa il **context server condiviso**
   (engine "shared") invece della WKWebView nativa, così mobile joina lo stesso
   `contextId`. Riusa il fan-out. → è ciò che rende la sessione *condivisa*.
2. **Transport max-perf**: sidecar Rust `webrtc-rs` + VideoToolbox H.264 + DataChannel
   input. → è ciò che la rende *fluida a bassa banda*.

Si compongono: (1) senza (2) = condivisa ma JPEG pesante; (2) senza (1) = fluida ma
non condivisa. Servono entrambi per il goal.

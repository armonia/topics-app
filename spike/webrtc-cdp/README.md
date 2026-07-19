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

## Ordine di build (due workstream ortogonali)

1. **Sharing** (abilita "stessa sessione"): il Mac usa il **context server condiviso**
   (engine "shared") invece della WKWebView nativa, così mobile joina lo stesso
   `contextId`. Riusa il fan-out. → è ciò che rende la sessione *condivisa*.
2. **Transport max-perf**: sidecar Rust `webrtc-rs` + VideoToolbox H.264 + DataChannel
   input. → è ciò che la rende *fluida a bassa banda*.

Si compongono: (1) senza (2) = condivisa ma JPEG pesante; (2) senza (1) = fluida ma
non condivisa. Servono entrambi per il goal.

# Verdetto spike — Co-browse "browser vero" via DOM streaming (rrweb)

**Data:** 2026-07-20 · **Stato:** feasibility PROVATA · **Codice:** `spike/rrweb-cobrowse/`

## Problema

La pane browser di un progetto sul Mac (Tauri) usa una **WKWebView nativa privata**
(`shared=false` di default). Il web/telefono a `https://macbook:3333/` vede solo la
sessione **server-side** (un browser separato) e la riceve come **stream** (oggi WebRTC,
senza fallback → schermo bianco se l'ICE cross-device non chiude). Richiesta di Attilio:
**stesso stato live**, ma **"il browser vero, non un video"**, riusabile per **co-op** e
**multi-sessioni**, con **Rust** dove serve.

## Cosa è stato misurato (gate)

`bun spike/rrweb-cobrowse/harness.mjs` — **11/11 check verdi**:

| target | eventi | full snap | steady-state | latenza cattura | similarity src↔follower |
|---|---|---|---|---|---|
| fixture (contatore live ogni 500ms) | 16 | 6.0 KB | **1.27 KB/s** | 1.3 ms | **1.00** |
| example.com | 2 | 1.7 KB | ~0 | 0.5 ms | **1.00** |

- La ricostruzione è **fedele** (screenshot src vs follower in `shots/`, verificati anche a
  occhio) e **nativa** (HTML/CSS reale, testo selezionabile), non pixel.
- Le **mutazioni live** si propagano (il contatore ricostruito è > 0 sul follower).
- Banda a regime **~1.3 KB/s** vs **~600 KB/s** del JPEG-over-WS misurato in
  `spike/webrtc-cdp` → **~500× meno**.

## Architettura

**Una sorgente di verità per sessione = il Chromium headless del server** (runna JS, tiene
login/cookie). Due canali, un broker:

1. **Canale DOM (rrweb, JSON leggero) — il "browser vero".** `addInitScript(rrweb)` nella
   pagina sorgente → eventi (snapshot + mutazioni + scroll + cursore) fanned out ai viewer,
   che ricostruiscono il DOM nel **motore nativo** del device. Input dei controller → CDP.
2. **Canale pixel-island (solo dove il DOM non basta).** `<canvas>` / `<video>` / WebGL /
   DRM → si strema **solo quella regione** via il **Rust `webrtc-bridge` già esistente**,
   compositato sopra il DOM ricostruito.

**Broker session-scoped + role-aware** (il cuore riusabile):
- chiave `sessionId` → **multi-sessione** (sorgenti indipendenti, ognuna col suo fan-out);
- peer con **ruolo** `source|presenter|controller|viewer` → **co-op** (input gate: solo
  presenter/controller guidano; presence broadcastata; handoff del controllo = cambio ruolo).

Contratto NDJSON unico, due implementazioni:
- `server.mjs` (riferimento JS, demo live con Playwright + Bun.serve);
- `bridge/` = **skeleton Rust `cobrowse-bridge`** (zero deps, compila in ~4s, smoke test:
  fan-out + relay + isolamento multi-sessione + presence verdi). È il multiplexer che
  diventa il sidecar di produzione, allineato a `webrtc-bridge`/`pty-bridge`.

## Dove sta Rust (onesto)

- **Isole pixel (canvas/video) → Rust, sì**: è già il `webrtc-bridge` (H.264 + VideoToolbox).
  Qui Rust è insostituibile (encode HW, banda).
- **Fan-out DOM (JSON) → Rust opzionale**: Bun regge il fan-out JSON di per sé. Il valore di
  un **broker Rust unico** è (a) un solo processo a bassa RAM per *tutte* le sessioni (ethos
  Tauri low-RAM), (b) stessa sede della governance co-op (ruoli/presence/handoff) e del
  canale pixel-island, (c) toglie il fan-out dall'event loop del server. Lo skeleton
  `bridge/` è pronto per questa scelta; in produzione si decide se attivarlo o tenere il
  fan-out in TS. **Non forziamo Rust dove non paga.**

## Confronto transport

| | JPEG-over-WS (legacy) | WebRTC H.264 (attuale) | **DOM co-browse (rrweb)** |
|---|---|---|---|
| Resa | filmato, letterbox 1280 | filmato, near-native | **DOM nativo, nitido, selezionabile** |
| Banda steady | ~600 KB/s | ~decine–100+ KB/s | **~1–5 KB/s** |
| Cross-device | ok (WS) | fragile (ICE/NAT, no fallback) | **ok (WS/NDJSON, no ICE)** |
| Canvas/video/WebGL | ✅ | ✅ | ❌ → isola pixel |
| Agent-drivable | ✅ | ✅ | ✅ (sorgente CDP) |
| Login una volta | ✅ | ✅ | ✅ |

**Sintesi: ibrido.** DOM co-browse di default (browser vero, leggerissimo, stesso stato
live, robusto cross-device) + isola pixel per canvas/video + WebRTC come fallback universale.
Non si butta niente di esistente: si aggiunge il canale che mancava.

## Piano di adozione (task board)

- **T1 — Canale DOM in produzione.** `addInitScript(rrweb)` in `browser-service.ts` + binding
  emit; varianti Zod `dom_snapshot|dom_incremental|dom_input` in `browser-ws-messages.ts`
  (+ mirror client, additive); fan-out sul `/ws/browser/:ctx` esistente; ramo rrweb Replayer
  nel client dietro toggle **DOM ↔ video**; bootstrap late-join (Meta+FullSnapshot+incrementali).
  E2E: fedeltà DOM + propagazione mutazioni + input round-trip.
- **T2 — Isole pixel.** Rileva canvas/video, strema la regione col `webrtc-bridge`,
  compositala sul DOM. E2E: pagina con `<video>` → isola pixel, resto DOM.
- **T3 — Broker Rust (opz.) + co-op.** Porta `cobrowse-bridge` a sidecar `externalBin`
  (`TOPICS_COBROWSE_BIN`); ruoli/presence/handoff del controllo; multi-sessione. Aggancia
  all'epic co-op (friendship/org/permessi per-chat/per-progetto/link).

## Rischi / limiti

- **JS solo lato server**: i follower sono un mirror del DOM, non un secondo runtime →
  canvas/video/WebGL vanno su isola pixel (mitigato in T2).
- **Asset cross-origin**: CSS inlinato da rrweb (`inlineStylesheet`); immagini per-URL
  (fetch nativo del follower) — per air-gapped `inlineImages:true`.
- **Latenza input**: click round-trippa alla sorgente prima dell'update DOM → su LAN
  decine di ms, impercettibile; fuori LAN pesa la RTT (come ogni sessione remota).
- **Shadow DOM / iframe cross-origin**: rrweb li gestisce ma con edge case → coperti in E2E.

## Raccomandazione

**Adottare il modello ibrido**, DOM co-browse come default per lo "stesso stato live nativo".
La feasibility è provata e la banda è un ordine di grandezza sotto qualsiasi stream. Partire
da **T1** (canale DOM + toggle) dietro cui c'è già metà infrastruttura (fan-out, input→CDP,
ramo iframe). Rust entra in **T2/T3** dove paga davvero (isole pixel, broker unico co-op).

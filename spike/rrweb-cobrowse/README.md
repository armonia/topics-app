# Spike — Co-browse "browser vero" via DOM streaming (rrweb), non video

Obiettivo (parole di Attilio): *"vorrei usare proprio il browser vero e non un video
stream"*, con **stesso stato live Mac↔mobile**, e architettato per **riusarlo sia per il
co-op sia per le multi-sessioni**, sfruttando **Rust** dove serve.

## L'idea

Invece di spedire **pixel** (JPEG/H.264, il path attuale), si spedisce il **DOM**.
Una sola sessione vera = il **Chromium headless del server** (runna JS, tiene login).
Gli si inietta **rrweb**: cattura snapshot DOM + mutazioni + scroll + cursore e li manda
come **JSON minuscolo**. Ogni device ricostruisce quel DOM nel **proprio motore nativo**
(WKWebView) → testo nitido e selezionabile, scroll nativo, accessibile. È "il browser
vero" perché renderizza HTML/CSS reale. Gli input dei follower tornano indietro → CDP
sulla sessione sorgente. **Stesso stato live, una sorgente, zero video.**

## Feasibility gate — MISURATO (2026-07-20)

`bun spike/rrweb-cobrowse/harness.mjs` — inietta rrweb in una pagina sorgente headless,
registra lo stream DOM, **ricostruisce** in un follower via rrweb Replayer, confronta gli
screenshot (MAE pixel downscalato) e verifica che le **mutazioni live** si propaghino.

| target | eventi | full snapshot | steady-state | latenza cattura | similarity | fedeltà |
|---|---|---|---|---|---|---|
| fixture (contatore live) | 16 | 6.0 KB | **1.27 KB/s** | 1.3 ms | 1.00 | 6/6 check |
| example.com | 2 | 1.7 KB | ~0 KB/s | 0.5 ms | 1.00 | 5/5 check |

**Verdetto: viabile e clamoroso sulla banda.** ~**1.3 KB/s** a regime contro i **~600 KB/s**
del JPEG-over-WS misurato nello spike WebRTC (`spike/webrtc-cdp`, 4.8 Mbps @ everyNthFrame:1):
**~500× meno banda**, rendering **nativo** (non un filmato), stesso stato live (il contatore
che muta ogni 500ms si ricostruisce fedele sul follower). Screenshot in `shots/`.

### Broker live — PROVATO end-to-end (2026-07-20)

`bun spike/rrweb-cobrowse/live-check.mjs` — pilota `server.mjs` (non la sola fattibilità
rrweb): un `controller` + un `viewer` sulla stessa sessione + un `viewer` su una sessione
diversa. **7/7 verde**: il late-joiner fa **bootstrap** (meta+full → ricostruzione nativa),
la **presence** arriva, il **gate co-op** regge (input del viewer **droppato**, input del
controller **relayato → CDP** → la sorgente muta), la mutazione **fa fan-out** all'altro
viewer, e l'**isolamento multi-sessione** tiene. Segnale univoco: `#go` appende `manuale:`
(l'auto-feed usa `evento auto`), quindi ogni `manuale:` nello stream è un click che ha
davvero raggiunto la pagina sorgente.

### Dove il DOM non basta (isole → pixel)
`<canvas>` / `<video>` / WebGL / DRM non si trasmettono via DOM: per **quelle regioni** si
strema il pixel (→ il **Rust `webrtc-bridge`** che già esiste), compositato sopra il DOM.
Il JS gira solo sul server: i follower mostrano il DOM live, non un secondo runtime — per
doc/dashboard/form/e-commerce (il grosso) è indistinguibile dal nativo.

## Riuso co-op + multi-sessione (per design, non a parole)

Il broker è **session-scoped e role-aware** dal primo commit, così lo STESSO layer serve:

- **multi-sessione**: chiave `sessionId` → sorgenti indipendenti, ognuna fanned out ai
  propri viewer.
- **co-op**: N peer per sessione con **ruolo** (`source` / `presenter` / `controller` /
  `viewer`); l'input è relayato **solo** dai controller (gate co-op), presence broadcastata.

Due implementazioni dello **stesso contratto NDJSON**:
- `server.mjs` — riferimento JS del broker (usa Playwright + Bun.serve), demo live.
- `bridge/` — **skeleton Rust** (`cobrowse-bridge`, **zero dipendenze**, compila in ~4s),
  il multiplexer che diventa il sidecar di produzione, allineato a `webrtc-bridge`/
  `pty-bridge` (crate + socket unix + `externalBin` + `TOPICS_*_BIN`). Non parsa i payload:
  li instrada per `(session, role)` → transport/format-agnostic (rrweb oggi, presence/
  pixel-island domani).

## Come si prova

```bash
# 1) Gate automatico (misure + fedeltà + screenshot compare)
bun spike/rrweb-cobrowse/harness.mjs

# 2) Broker Rust (compila + smoke fan-out/relay/isolamento)
cd spike/rrweb-cobrowse/bridge && cargo build --release

# 3) Demo LIVE nel browser vero
bun spike/rrweb-cobrowse/server.mjs
#   → http://localhost:8879/                              (viewer)
#   → .../client.html?live=1&session=demo&role=controller (guida)
#   apri 2+ tab: vedono la STESSA sessione live; ?url=https://… per un sito reale
```

## Come si aggancia a Topics (produzione)

- **Sorgente**: `server/browser-service.ts` già possiede il context headless + CDP; si
  aggiunge l'`addInitScript(rrweb)` (come già si fa per i tool agent) + un binding che
  pompa gli eventi.
- **Transport**: riusa il WS `/ws/browser/:ctx` con **fan-out** già esistente
  (`browserWsClients`); nuove varianti Zod `dom_snapshot | dom_incremental | dom_input` in
  `server/browser-ws-messages.ts` (+ mirror client), additive/retro-compatibili.
- **Follower**: nel client, un ramo `RemoteBrowserPanelStreaming` che monta rrweb Replayer
  quando la pane è in modalità "DOM live" (toggle **DOM ↔ video**); l'`<iframe>` framable
  di oggi è già il primo mattone.
- **Input**: `sendInput` (già → CDP) trasporta `dom_input`.
- **Isole pixel**: canvas/video → il Rust `webrtc-bridge` esistente, compositato.

Vedi `EVALUATION.md` per il verdetto esteso e il piano di adozione.

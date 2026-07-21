# Design — browser-native-host-cobrowse

## Modello: host dinamico, server di riserva

Una tab = **un host di render alla volta**. Chi guida rende nativo; gli altri seguono.

```
        ┌─────────────── una sessione (un contextId canonico) ───────────────┐
        │                                                                     │
   ┌────▼─────┐  controllo/host   ┌──────────────┐   follower (pixel+input)  ┌▼──────────┐
   │ Mac app  │◄─────────────────►│  host attivo  │──── CDP screencast ─────►│ iPhone PWA│
   │ (host)   │   handoff raro    │ Chromium reale│    → WebRTC H.264 (RTC)   │ (follower)│
   └────┬─────┘                   └──────┬───────┘   ◄─── input relay ────────└───────────┘
        │ jar/cookie (CDP)               │ agente (CDP / native-executor)
        │                                │
   ┌────▼──────────────── server = host di RISERVA + signaling + TURN + jar autoritativo ┐
   │  subentra se nessun device è sveglio / agente headless-only (chrome-headless-shell) │
   └─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Host attivo**: il device in controllo. Rende in un **Chromium gestito** (headful).
  Da solo NON trasmette: è un browser locale, latenza zero.
- **Follower**: vede il pixel dell'host (WebRTC H.264, fan-out N-peer) e rimanda l'input
  con l'**overlay della Fase 0** (mappa coordinate + `sendInput`). Media inclusi.
- **Server di riserva**: host quando nessun device è attivo o per l'agente headless.
  Tiene il **jar autoritativo**. È anche signaling (`/ws/browser/:ctx`) + TURN.
- **iPhone**: sempre follower (una PWA non cattura/streamma la pagina).

Regola d'oro anti-migrazione: il passaggio di **controllo** NON ri-hosta (cambia solo la
direzione dell'input relay). Si ri-elegge un host **solo** quando l'host corrente
sparisce (sleep/close) → l'evento raro in cui serve portare la sessione.

## Motore per ruolo (deciso su misure)

| Ruolo | Motore | Trasporto CDP | Perché |
|---|---|---|---|
| Device host (mac/linux) | Chromium headful gestito (o `ungoogled-chromium`) | **pipe** | serve una finestra on-screen; il full build non bind-a la porta TCP |
| Device host (windows) | opz. WebView2 (Chromium/Edge) | port | runtime condiviso = RAM/disco ammortizzati (caveat: regression CDP per processi elevati) |
| Server riserva / nodo render follower | **chrome-headless-shell** | port | ~2.7× più leggero (≈246 MB vs ≈700 MB), stesso 99 fps / ~1 ms input, ~1 s avvio |

`--headless=new` è il mezzo scomodo (RAM da full build senza finestra) — solo se servono
feature full (estensioni/codec) headless. **Thorium scartato**: perf marketing eroso da
V8 + manutentore singolo su base LTS semestrale (security-lag). **Servo/Verso/Ladybird**:
watch-only.

## Trasporto follower

- Cattura: **CDP `Page.startScreencast`** (jpeg, backpressure via `screencastFrameAck`).
  fps engine-independent (~99–100 misurati, change-driven → pagina statica ~0 fps).
  Nessun setter fps: `everyNthFrame` decima soltanto. Batte un loop `captureScreenshot`
  di ~2–3×.
- Trasporto: **WebRTC H.264** via il `webrtc-bridge` Rust già esistente (una
  `TrackLocalStaticSample` per target → fan-out N-peer; openh264 SW oggi, VideoToolbox HW
  TODO). Oltre-LAN: TURN. Il bridge oggi ha source = Chromium server; qui va aggiunto
  **source = device host**.
- Input follower: l'**overlay** della Fase 0 sopra il `<video>` (stessa `mapCoordinates`
  del path video); relay `{type:'input'}` → CDP `Input.dispatch*` (trusted).

## Portabilità di sessione (il nodo make-or-break)

Con Chromium ovunque l'handoff è tratteggiabile e testabile:
1. **Jar autoritativo lato server** (l'àncora). Gli host si agganciano a quella
   sessione.
2. Handoff host→server / host→host = `Network.getAllCookies` sull'uscente →
   `setCookies` sull'entrante (+ storage/`IndexedDB` dove serve, best-effort). Stesso
   formato Chromium ⇒ niente re-login nel caso comune.
3. Handoff **raro** (solo su departure dell'host) → la superficie di rischio è minima.
   Token device-bound / 2FA restano il limite onesto: fallback = re-auth lazy sul nuovo
   host (URL sempre preservato).

## Seam di control-plane (hedge BiDi)

Tutto CDP passa per **una** interfaccia `BrowserControl` (navigate, screencast,
input, cookies). Implementazione oggi: `CDPControl` (pipe o port). Domani: `BiDiControl`
si aggancia allo stesso seam quando `browsingContext.startScreencast` + input BiDi
maturano e Safari li spedisce — zero impatto sul codice prodotto. Ri-valutazione
programmata: Ladybird (stable ~2028), Servo `libservo`.

## Fasi

- **Fase 0 — Overlay input (FATTO, `ce871d1f`).** Cattura input nel frame principale
  per il co-browse DOM: WKWebView-safe, tastiera hardware + mobile/IME/paste, selezione
  on-Option. e2e 3/3. È anche il primitivo di input dei follower.
- **Fase 1 — Host nativo + election + riserva server.** Chromium gestito on-device come
  host di default (flip di `shared`), `BrowserControl` seam, host-election
  promote/demote, server = riserva. Riusa `register_native_executor`.
- **Fase 2 — Trasporto follower.** `webrtc-bridge` con source = device host; overlay
  input follower sul `<video>`; TURN oltre LAN.
- **Fase 3 — Portabilità sessione + sync.** Handoff cookie CDP; jar autoritativo;
  sync tab/cronologia/preferiti/password cross-device (`yrs`/`automerge`).
- **Fase 4 — Superficie top-browser + cuneo AI.** Omnibox/tab/estensioni/autofill/
  download/reader/adblock; l'agente che condivide la TUA tab cross-device (il
  differenziatore).

## Rischi / trade-off onesti

- **Host che dorme** → la riserva server copre (costo: si mantiene Chromium
  server-side; scelta esplicita dell'utente = opzione 1).
- **Compositare la finestra Chromium nativa nel layout Tauri** è l'integrazione più
  tosta della Fase 1 (CEF vs finestra esterna gestita vs screencast-locale): spike
  dedicato prima di cablare.
- **RAM**: full Chromium ~700 MB/host; mitigazioni misurate — headless-shell dove non
  serve finestra, tab-discarding (<10 MB sospese), `--renderer-process-limit`,
  site-isolation off (~10–13%, valutare Spectre).
- **Selezione testo locale** nel mirror resta un compromesso (overlay robusto vs
  selezione nativa) fino a che l'host nativo (Fase 1) rende il mirror un fallback.

# D1 — Browser pane nativo nello shell Tauri (ricerca completa)

> Esito del workflow multi-agente `native-browser-pane-tauri` (11 agenti, 5 fasi:
> research → contract → design → verify avversariale → sintesi). 2026-06-25.
> Vincolo utente: **"deve essere nativo non finto"** — niente screencast/pixel streammati.

## Raccomandazione: CEF on-demand (Chromium reale embedded)

Per il pannello browser usa **CEF (Chromium Embedded Framework) via `cef-rs`**,
montato come **vera child view nativa** (NSView su macOS, HWND su Windows, X11 su
Linux) compositata sopra la UI React. La main UI resta sul system-webview leggero
(WKWebView/WebView2/WebKitGTK).

**Non è screencast.** È un processo Chromium reale che si dipinge da solo sul
compositor GPU, latenza nativa — l'esatto analogo dell'attuale `WebContentsView`
Electron, senza Electron. Precedenti in produzione: **OpenHuman** (open-source,
Tauri+CEF+CDP) e **atrium** (closed, miglior writeup). Engine **Chromium uniforme
su tutti e 3 gli OS** — niente frammentazione WebKit, niente rifiuti OAuth/passkey/FedCM.

## Controllo agent — parità totale, costo zero di riscrittura

CEF parla **CDP nativamente**. I 23 op del contratto portano 1:1: `console`
ring-buffer (`Runtime.consoleAPICalled`), `import_chrome`/httpOnly via
`Network.setCookies`, input **trusted** (`Input.dispatch`, `isTrusted=true`),
download/permission interception, e `Page.startScreencast` per il mirroring
multi-client (web client + thumbnail in-chat) — che resta identico.
`server/browser-cdp-raw.ts` + `browser-cdp-dispatcher.ts` si trapiantano quasi
verbatim: cambi solo l'endpoint CDP (raw attach su `--remote-debugging-port`,
oppure `chromiumoxide`).

**Onestà sui non-CDP engine:** scartati apposta per evitare i loro buchi.
Scegliendo CEF **non perdi nulla**. Su WKWebView/WebKitGTK avresti perso: console
history completa (override JS fragile, perde i log early), input trusted (richiede
CGEvent/AX su mac), cookie httpOnly (API native per-runtime), screencast efficiente.

## RAM

- **vs Electron:** idle near-system-webview (Chromium spinge su solo quando apri un
  pannello) → **~117 MB vs ~627 MB misurati (−47%…−87%)**. Per-pannello aperto:
  ~50-90 MB floor/renderer, 300-500 MB SPA pesanti. Bundle +~170 MB Chromium,
  **lazy-downloadable** via `cef-dll-sys` → installer base resta snello.
- **vs screencast:** identico rendering nativo, **zero overhead di encoding/decode
  JPEG** e nessuna latenza video. Lo screencast resta solo per i viewer remoti.

## Piano D1 (Tier 1) — ~14 settimane

1. **Spike macOS prima (sett. 1-3, IL rischio):** NSView wrapper, `layer.zPosition=-1`,
   `drawsBackground=NO`, **`hitTest:→nil`** quando un overlay è aperto. **Già risolto
   in questo repo** in Electron (`electron-app/native/vibrancy/vibrancy.mm`, addon
   `vibrancy.node`, overlay-manager BrowserWindow always-on-top) → trapianta il pattern.
2. **CDP layer (sett. 3-5):** attach raw a CEF, porta `browser-cdp-raw.ts`. Basso rischio.
3. **Geometry sync (sett. 5-6):** ResizeObserver→Tauri command→`set_bounds`, watchdog 500ms.
4. **Windows HWND `SetParent` (sett. 7-9)** e **Linux X11 (sett. 10-13, più debole,
   Wayland non reparenta).**
5. **Init defer + iframe localhost special-case + Cmd+Shift+E overlay (sett. 13-14).**

**Spike prima:** (a) compositing+hitTest CEF-in-Tauri su macOS, (b) cold-init CEF
(~0.5-2s) deferribile oltre il first paint, (c) embedding Linux/Wayland (fattibilità reale).

## Verifica avversariale

3 lenti (rendering-interactivity / automation-parity / ram-crossplatform-effort).
**Refutata** l'opzione "resta su Electron" sull'asse RAM (full Chromium sempre
residente, 0 risparmio) — è solo lo yardstick di parità, non la risposta. CEF è
l'unica che mantiene parità CDP al 100% **E** taglia la RAM idle del ~47-87%, a
rischio *medio* (non *high* come le alternative WKWebView-multiengine o ibride).
Punto fragile reale: embedding cross-OS oltre macOS → spike-first.

## Nota sullo scaffold

`desktop-tauri/` attuale è un `create-tauri-app` di default (no multiwebview/CEF
deps, no comandi Rust custom): è plumbing di progetto, **non** un head-start su CEF.

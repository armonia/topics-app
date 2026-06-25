# Topics — Porting Plan: low-footprint + multi-device

> Stato: **draft / in esecuzione** · Avviato 2026-06-25 · Owner: Attilio + Jarvis
> Goal: porting totale a stack a bassissimo impatto RAM/CPU, **un tier alla volta con
> gate di valutazione**, mantenendo **parità totale di funzionalità** e abilitando
> **multi-device** (web, PWA, telefono).

## 0. Reframe architetturale (perché il piano cambia)

Il vincolo "supporto altri dispositivi (telefono/PWA/sito)" **riscrive** la strategia
emersa nella prima valutazione:

- Il **80% del peso RAM** non è React: è **Chromium impacchettato dentro Electron**
  (~548 MB su ~627 MB totali misurati). Si attacca quello.
- Il **"Tier 3 nativo senza WebView"** (Swift/Rust UI) **è incompatibile** con il
  multi-device: butti il codice React condiviso e ti servono UI separate per
  web/telefono. Quindi viene **ridefinito** (vedi Tier 3).
- La PWA **esiste già al ~70%**: `manifest.json`, `sw.js` (v9), service worker
  registration, meta apple-mobile, `useMobile.ts`, 51 file con codice responsive,
  server che serve `/public` su HTTP/TLS. Device-support = **consolidare**, non creare.

### Architettura target: un core web-first, tre shell

```
                 ┌─────────────────────────────────────────────┐
                 │   CORE WEB-FIRST  (React 19, l'attuale /client)│
                 │   — UI, stato (zustand), WS client            │
                 └───────────────┬─────────────────────────────-┘
        ┌───────────────────────┼───────────────────────────────┐
        ▼                       ▼                                 ▼
  A. WEB / PWA            B. DESKTOP (Tauri)              C. MOBILE (opz.)
  browser + telefono     sostituisce Electron            Tauri-mobile / Capacitor
  feature native = no-op nativo: pty, browser pane,      stesso core, wrapper store
  (degrado elegante)     vibrancy, tray                  (solo se serve app-store)
```

Le feature **desktop-only** (terminale pty, browser pane via CDP, vibrancy macOS)
**degradano elegantemente** su web/mobile: la stessa UI, ma quei pane mostrano un
fallback ("disponibile su desktop") invece di rompersi.

## 1. Footprint misurato (baseline 2026-06-25)

| Componente | RSS | Note |
|---|---|---|
| Electron main + 4 helper | ~548 MB | Chromium — bersaglio primario |
| Bun server | ~61 MB | folddabile in-process (Tier 2) |
| pty-bridge | ~18 MB | |
| **Totale app** | **~627 MB** | esclusi i `claude` PTY (carico utente) |

Codice: client **67.5k LOC / 125 componenti** · server **~44k LOC** · electron
`main.ts` **4.363 LOC** (166 ref browser/CDP) · core browser-CDP **5.020 LOC**.

Accoppiamento client→shell: **un solo bridge** (`window.electronAPI`, 17 file,
~48 canali IPC). → swap shell = riscrivere UN bridge.

## 2. Matrice di parità funzionale (il contratto "porting totale")

| Feature | Web/PWA | Desktop (Tauri) | Mobile | Difficoltà port |
|---|:---:|:---:|:---:|---|
| Chat + streaming | ✅ | ✅ | ✅ | nessuna (già web) |
| Sidebar / topic tree | ✅ | ✅ | ✅ (drawer) | bassa |
| Editor CodeMirror | ✅ | ✅ | ✅ ro/light | nessuna |
| Markdown render | ✅ | ✅ | ✅ | nessuna |
| File explorer / git | ✅ | ✅ | ✅ | bassa (API già REST) |
| Split / layout | ✅ | ✅ | ⚠️ stack singolo | media (mobile) |
| **Terminale (pty)** | ❌→fallback | ✅ | ❌→fallback | **alta** (vedi T1) |
| **Browser pane (CDP)** | ❌→fallback | ⚠️ vedi decisione | ❌→fallback | **altissima** (il blocco) |
| Vibrancy macOS | n/a | ✅ | n/a | media (cosmetica) |
| Tray / shortcut / power | n/a | ✅ | n/a | bassa |
| Push notifications | ✅ (web-push) | ✅ | ✅ | nessuna (già c'è) |

Legenda: ✅ parità · ⚠️ parità ridotta/decisione · ❌→fallback degrado elegante.

## 3. Il blocco unico: browser pane via CDP

`WebContentsView + CDP` = chiave di volta, **è Chromium** (5.020 LOC server + 166 ref
in `main.ts` + ~metà dei canali preload `browser-native:*`). Nessun target low-impact
(Tauri/WKWebView/WebKitGTK) ha WebContentsView né CDP. Tre uscite, in Tier 1 si decide:

1. **WKWebView/WebKitGTK embedded** + controllo via JS injection nativo →
   leggerissimo, **perdi la parità CDP** (MCP/Jarvis che pilotano il pannello).
2. **Sidecar Chromium-via-CDP on-demand** (solo quando un pannello è aperto),
   screencast nella WebView → pesa solo all'uso, **mantiene CDP**.
3. **Descope**: niente browser embedded, apri esterno → max semplificazione,
   perdi una feature core.

→ **Raccomandazione: opzione 2** (mantiene la feature + parità, costo isolato e
on-demand). Decisione formale richiesta nel gate di Tier 1.

---

## 4. I tre tier — sequenza, scope, gate di valutazione

Ogni tier ha **criteri di uscita misurabili**. Non si passa al successivo finché il
gate non è verde.

### TIER 1 — Desktop su Tauri + PWA first-class  ⏳ IN CORSO

> **✅ T1.0 GATE VERDE (2026-06-25).** Spike reale: Tauri v2 (`desktop-tauri/`)
> compila e apre una finestra "Topics" 1400×900 che renderizza il React esistente
> caricato dal server live `:3333`. Footprint misurato:
> **Tauri ~117 MB** (main 79 + GPU 14 + Net 8 + WebContent 16) vs **Electron
> 221 MB pulito / 926 MB con browser pane** → **−47% … −87%**. RSS Tauri è un
> upper-bound (framework WebKit condiviso col sistema). **Decisione: si procede.**

**Obiettivo:** sostituire Electron con Tauri v2 (Rust + system WebView), tenendo
React e il server Bun come sidecar. Consolidare il path web/PWA.

> **✅ ARCHITETTURA VERIFICATA (2026-06-25).** Tauri inietta l'IPC nativo SOLO nelle
> pagine servite localmente (`tauri://`), MAI in un origin http remoto — provato con
> self-test su file (locale: `internals=true` + `perf_metrics` risponde `139MB`;
> remoto `:3333`: niente). Conseguenza: la shell serve `/public` **localmente** e
> parla col server `:3333` solo per i dati. Implementato e committato (`331d27c`):
> client WS via `serverWsBase()` + shim globale `fetch` per i path `/api`; CORS
> additivo lato server. Tutto **gated su `isTauri`** → web/Electron invariati.

**Scope:**
- [x] T1.0 — **Spike Tauri** ✅: `desktop-tauri/` scaffolded (Rust 1.96 + Tauri v2),
      carica il server live `:3333`. Misurato **117 MB vs Electron 221-926 MB**. GO.
- [x] T1.1 — **Shell bridge** ✅ (`client/src/lib/shell/`): `detectShell()` electron/tauri/web,
      `capabilities`, facade `app`/`perf`, `net` (serverWsBase + fetch-shim). Additivo, typecheck verde.
- [~] T1.2 — Bridge IPC: plugin nativi (opener/process/os) + comando `perf_metrics` live;
      facade `app`/`perf` pronti. Resta: migrare i ~22 callsite dal `electronAPI` al facade.
      ⚠️ CORS server committato ma **non applicato** (serve restart prod, da fare insieme).
- [ ] T1.3 — Shell nativa: tray, global shortcut, powerMonitor, nativeTheme,
      **vibrancy per-region** (`window-vibrancy` + pezzo custom dello split).
- [ ] T1.4 — Terminale: pty via `portable-pty` (Rust nativo, **D2 risolto**); rispetta
      il contratto NDJSON + migra/bridge la session-layer di `routes/terminal.ts`.
- [ ] T1.5 — **Browser pane nativo = CEF on-demand** (D1 risolto). Sotto-piano ~14 sett.:
      - [ ] T1.5a — **SPIKE macOS (sett.1-3, IL gate)**: CEF-in-Tauri come NSView child,
            `zPosition=-1`, `drawsBackground=NO`, **`hitTest:→nil`** (trapianta `vibrancy.mm`);
            verifica compositing + cold-init CEF (~0.5-2s) deferribile oltre il first paint.
      - [ ] T1.5b — CDP layer (sett.3-5): raw-attach a CEF, porta `browser-cdp-raw.ts`.
      - [ ] T1.5c — Geometry sync (sett.5-6): ResizeObserver→Tauri cmd→`set_bounds`, watchdog 500ms.
      - [ ] T1.5d — Windows HWND `SetParent` (sett.7-9); Linux X11 (sett.10-13, più debole, no Wayland).
      - [ ] T1.5e — Init defer + iframe-localhost special-case + overlay menu (sett.13-14).
- [ ] T1.6 — PWA hardening: audit Lighthouse PWA, offline-shell, install prompt,
      verifica feature-degradation su mobile reale.

**Gate di valutazione (esci da T1 quando TUTTI verdi):**
- RAM desktop idle **< 300 MB** (target -50%+).
- Parità funzionale desktop = matrice §2 soddisfatta (browser pane secondo decisione).
- PWA Lighthouse score ≥ 90, installabile + usabile da telefono su LAN/cloudflare.
- Build CI a 3 OS verde (o almeno mac, con piano win/linux).

### TIER 2 — Server nativo in-process + idle-CPU

**Obiettivo:** rimuovere il processo Bun separato; backend in Rust dentro Tauri
(o sidecar compilato), SQLite via `rusqlite`. Tagliare CPU idle e RAM residua.

**Scope:**
- [ ] T2.1 — Port incrementale dei router server (REST/WS) Bun→Rust (axum) **dietro
      lo stesso contratto WS/REST** (così la PWA web continua a girare sul server Bun
      finché vogliamo: il server resta deployabile per il web).
- [ ] T2.2 — SQLite `rusqlite`; riusa lo schema/migrazioni esistenti.
- [ ] T2.3 — pty + browser-tools engine: decidere cosa resta sidecar vs nativo.
- [ ] T2.4 — Idle audit: timer/observer/WS keepalive → ridurre wakeups.

**Gate:** RAM desktop **< 200 MB**, CPU idle < baseline misurata, **web/PWA ancora
servibile** (il server Bun resta disponibile come deploy web), parità invariata.

### TIER 3 — Iper-ottimizzazione web-first (RIDEFINITO)

> ⚠️ **NON** è più "UI nativa senza WebView": romperebbe il multi-device. È la
> spremitura massima dello stack web-first, **restando deployabile ovunque**.

**Obiettivo:** minimo impatto RAM/CPU mantenendo un solo codice multi-device.

**Scope (candidati, da prioritizzare dopo T2):**
- [ ] T3.1 — Code-split aggressivo + lazy delle parti grasse (xterm 343KB,
      CodeMirror 314KB, markdown 157KB) caricate solo quando il pane si apre.
- [ ] T3.2 — Valutare frontend più leggero su CPU/heap per le viste hot (Solid/Svelte
      island) **solo dove paga** — non rewrite globale dei 67k LOC.
- [ ] T3.3 — WASM per hotpath (es. diff/parsing) se profiling lo giustifica.
- [ ] T3.4 — **Mobile native opzionale**: Tauri-mobile / Capacitor per distribuzione
      app-store (stesso core), se la PWA non basta.

**Gate:** bundle JS critico ridotto, RAM/CPU misurati ai minimi sostenibili,
**zero regressioni di parità su tutti i device**.

---

## 5. Principi trasversali (validi per ogni tier)

1. **Mai rompere la parità**: ogni step verifica la matrice §2 prima del merge.
2. **Il server resta deployabile per il web** in ogni tier → il "sito/PWA" non muore mai.
3. **Degrado elegante** delle feature desktop-only su web/mobile (no crash, fallback UI).
4. **Misura, non assumere**: ogni gate ha numeri (RAM/CPU/Lighthouse), non sensazioni.
5. **Incrementale e reversibile**: Electron resta finché Tauri non supera il gate T1.

## 5b. Contratto bridge & mappa capability (Electron → Tauri → Web)

Il client parla con la shell via **un solo oggetto** `window.electronAPI` (~22 file).
Contratto reale (da `client/src/types/electron-api.d.ts`), raggruppato per capability,
con l'equivalente Tauri v2 e il fallback web. Questa è la spec di **T1.2**.

| Capability | Electron (oggi) | Tauri v2 | Fallback Web/PWA |
|---|---|---|---|
| `browserNative.*` (CDP pane) | WebContentsView + CDP | **D1**: sidecar Chromium / WKWebView child | no-op → streaming (già esiste) |
| `overlay` / `overlayHost` | BrowserWindow trasparente | `WebviewWindow` multiwindow **o** portal HTML | portal HTML (web già lo fa) |
| `app.relaunch` / `getVersion` | `app.relaunch` / `app.getVersion` | `tauri-plugin-process` + `app.getVersion()` | `location.reload` / version build-time |
| `perf.getMetrics` | `app.getAppMetrics()` | crate `sysinfo` (Rust command) | Performance API (parziale) |
| theme (`nativeTheme`) | `nativeTheme` | window theme + `tauri-plugin-os` | `prefers-color-scheme` |
| `openExternal` | `shell.openExternal` | `tauri-plugin-opener` | `window.open` |
| caffeinate | `powerSaveBlocker` | Rust IOKit / plugin | no-op |
| daemon launchagent | `child_process` | `std::process` / `tauri-plugin-shell` | no-op |
| tray | `Tray` | `tauri-plugin-tray-icon` (core) | n/a |
| global shortcut | `globalShortcut` | `tauri-plugin-global-shortcut` | n/a |
| updater | `electron-updater` | `tauri-plugin-updater` | n/a (web auto-fresh) |

**Strategia T1.1/T1.2:** introdurre `client/src/lib/shell/` con `detectShell()` →
`'electron' | 'tauri' | 'web'` e un facade `shell` che espone questi gruppi; i ~22
callsite passano dal facade (oggi delega a `electronAPI`, domani a Tauri `invoke`).
Refactor **additivo e reversibile**: si fa solo dopo il gate T1.0 verde.

## 6. Decisioni (aggiornato 2026-06-25)

- **D1 — Browser pane**: ✅ **RISOLTO → CEF on-demand (Chromium reale embedded), NON finto.**
  Requisito utente: webview **reale** (DOM/scroll/interazione veri), non screencast.
  Esito ricerca multi-agente (workflow `native-browser-pane-tauri`, 11 agenti):
  - **Engine**: CEF (Chromium Embedded Framework) via `cef-rs`, montato come **child-view
    nativa** (NSView/HWND/X11) compositata sopra la UI React; main UI su system-webview leggero.
  - **Nativo davvero**: Chromium reale dipinge su GPU compositor, latenza nativa = analogo
    di `WebContentsView` Electron senza Electron. Prior art: **OpenHuman**, **atrium**.
  - **Parità agent 1:1**: CEF parla CDP nativamente → i 23 op del contratto invariati;
    `browser-cdp-raw.ts` + `browser-cdp-dispatcher.ts` si trapiantano quasi verbatim
    (cambia solo l'endpoint CDP, raw attach su `--remote-debugging-port` o `chromiumoxide`).
  - **RAM**: idle ≈117 MB (Chromium parte solo all'apertura di un pannello) → −47%…−87%
    vs Electron. Bundle +~170 MB Chromium, **lazy-download** (base installer snello).
  - **Engine non-CDP (WKWebView/WebKitGTK) SCARTATI** apposta: perderebbero console-history,
    input trusted, cookie httpOnly, screencast efficiente. Con CEF non si perde nulla.
  - **Rischio principale**: embedding cross-OS oltre macOS (Wayland non reparenta) → spike-first.
  - **Asset**: l'occlusione native-view (il pezzo macOS più duro) è GIÀ risolta in Electron
    (`electron-app/native/vibrancy/vibrancy.mm`, `hitTest:→nil`) → si trapianta.
  - **Fattibilità crate confermata (2026-06-25)**: `cef = "149.1.0+149.0.4"` (Chromium 149,
    pubblicato), `chromiumoxide = "0.9.1"` (client CDP Rust), `raw-window-handle = "0.6.2"`
    (handle nativo da Tauri). Resta da spike: download framework CEF (~170MB) + bundling
    macOS .app (helper processes in `Contents/Frameworks` — fiddly; esiste tool dedicato).
- **D2 — Terminale**: ⚠️ **RICLASSIFICATO → Tier 2** (scoperta in implementazione). Con il
  local-serve, i terminali restano serviti dal **pty-bridge del server** via `:3333/ws/terminal`
  (funzionano nel desktop senza codice nativo). Spostare il pty in Rust dentro Tauri
  richiederebbe un transport divergente (Tauri IPC invece della WS server) + duplicare la
  session-layer (`routes/terminal.ts`, 1642 LOC): è accoppiato alla migrazione server→Rust →
  appartiene a **Tier 2**. **Tier 1 tiene il pty sul server.** (Beneficio: Tier 1 più snello.)
  - **Contratto da rispettare** (oggi `pty-bridge.mjs`, 371 LOC, NDJSON):
    in `create{id,shell,args,cwd,cols,rows,env}` · `write{id,data}` · `resize{id,cols,rows}`
    · `kill{id}` · `list` · `buffer{id}` · `ping`; out `created{id,pid}` · `data{id,data}`
    · `exit{id,exitCode}` · `killed{id}` · `list{sessions}` · `buffer{id,data(b64)}` · `pong`.
  - ⚠️ **Dipendenza**: `routes/terminal.ts` (1642 LOC) tiene la session-layer (registry,
    activity-classification, lossless-reattach, ptyPid descendant-tree per i Processi,
    orchestrator-parenting dei sub-agent). Il pty raw va in Rust; questa logica o **migra**
    in Rust o **fa da bridge** → si lega alla topologia server (Tier 2). Va progettata
    insieme, non a pezzi.
- **D3 — Mobile**: ✅ **PWA è sufficiente** — consolidare manifest/SW/responsive, niente
  wrapper app-store. (Tier 3.4 cassato.)

## 7. Hardening sicurezza config Tauri (da review)

Lo spike `desktop-tauri/` punta a `http://localhost:3333` con `csp: null` **solo per
misurare la RAM** contro il server live — config **throwaway, non di produzione**.
La config Tauri di produzione DEVE:
- Caricare gli asset **bundled** (`frontendDist` → `tauri://localhost`) o **https**, mai
  un origin `http` plaintext remoto.
- Impostare una **CSP stretta** (`app.security.csp`), non `null`.
- **Non esporre l'IPC Tauri** a origin remoti: `app.security.capabilities`/
  `dangerousRemoteDomainIpcAccess` lockati al solo origin dell'app.

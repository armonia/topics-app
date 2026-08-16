# Topics — Porting Plan: low-footprint + multi-device

> Stato: **v2 CUTOVER (2026-07-02)** — Tauri è la shell desktop **PRIMARIA** (v2.0.0);
> Electron è **LEGACY/FROZEN** (solo manutenzione, niente feature nuove) fino al
> decommission (vedi §9). · Avviato 2026-06-25 · Owner: Attilio + Jarvis
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
| **Browser pane** | ❌→fallback | ✅ WKWebView+JS, agent **10/13 op** (vedi D1) | ❌→fallback | **altissima** (il blocco) |
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

### TIER 1 — Desktop su Tauri + PWA first-class  ✅ EXIT (v2 cutover 2026-07-02)

> **✅✅✅ TIER-1 EXIT / CUTOVER v2 (2026-07-02).** Tauri è dichiarata la shell desktop
> **primaria** — versione prodotto **2.0.0** (root `package.json`, `tauri.conf.json`,
> `Cargo.toml` in lockstep), canale release `tauri-v*` (`tauri-release.yml`). Electron
> passa **LEGACY/FROZEN** (manutenzione only); il decommission definitivo segue le wave
> residue in §9. Le checkbox di scope qui sotto sono **storiche** (fotografia in-corso):
> lo stato spedito reale è tracciato in §6 (D1–D4), §8 e nei memory-log di progetto.

> **✅ T1.0 GATE VERDE (2026-06-25).** Spike reale: Tauri v2 (`desktop-tauri/`)
> compila e apre una finestra "Topics" 1400×900 che renderizza il React esistente
> caricato dal server live `:3333`. Footprint misurato:
> **Tauri ~117 MB** (main 79 + GPU 14 + Net 8 + WebContent 16) vs **Electron
> 221 MB pulito / 926 MB con browser pane** → **−47% … −87%**. RSS Tauri è un
> upper-bound (framework WebKit condiviso col sistema). **Decisione: si procede.**

**Obiettivo:** sostituire Electron con Tauri v2 (Rust + system WebView), tenendo
React e il server Bun come sidecar. Consolidare il path web/PWA.

> **✅✅ TIER-1 CORE VALIDATO END-TO-END (2026-06-25).** La Tauri release carica
> `/public` localmente (`tauri://localhost`), il client rileva `isTauri` e si connette
> a **`https://127.0.0.1:3333`** (cert "Armonia Local CA" trusted dal keychain) + `wss`
> per la WS app; il CORS server (live dopo `kickstart -k topics-server`) risponde
> `Access-Control-Allow-Origin: tauri://localhost`. **Prova**: il processo WKWebView
> Networking dell'app teneva **33 connessioni ESTABLISHED a :3333**, UI popolata.
> **Footprint ~90 MB (app 54 + GPU 11 + Net 10 + WebContent 15) vs Electron 221-926 MB
> → −59%…−90%.** Il restart del server ha **preservato i PTY** (log: "PTYs preserved").
>
> Verificato anche il vincolo IPC: Tauri inietta `__TAURI_INTERNALS__` SOLO su origin
> locale `tauri://`, mai su http remoto (self-test su file). Da qui il local-serve.

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
      · **fatto il pezzo `recomposeWindow`**: nel porting era passata solo la metà
        "ri-ancora", senza il rimbalzo di 1px che è quello che ridisegna davvero, e
        senza nessun ascoltatore che lo chiamasse. Ora `wire_recompose_observers`
        aggancia `NSApplicationDidChangeScreenParameters` (centro di default) e
        `NSWorkspaceDidWake` (centro di NSWorkspace, non quello di default: è il
        no-op silenzioso classico) → `recompose_main_window`.
- [ ] T1.4 — Terminale: pty via `portable-pty` (Rust nativo, **D2 risolto**); rispetta
      il contratto NDJSON + migra/bridge la session-layer di `routes/terminal.ts`.
- [x] T1.5 — **Browser pane nativo — CHIUSO, ma non come diceva questo piano.**
      Il pane e' spedito da mesi sui webview DI SISTEMA: WKWebView su macOS
      (`lib.rs`), WebView2 su Windows (`browser_win.rs`), WebKitGTK su Linux
      (`browser_linux.rs`), con il layer di eval condiviso in `browser_eval.rs`.
      Funziona, e' in mano agli utenti, e non contiene una riga di CEF.

      **Perche' questa voce resta qui invece di sparire.** Lo spike CEF di
      giugno era vero e il suo gate era verde davvero: cef-rs compilava, il
      bundling era automatizzato, l'albero Chromium dipingeva. Quel che e'
      successo dopo e' che la strada scelta e' stata un'altra — piu' leggera,
      niente framework da 432 MB da spedire — e nessuno e' tornato a dirlo qui.
      Un agente che apriva questo file per capire dove stava il lavoro leggeva
      un cantiere da 14 settimane che non esiste, e ci perdeva un giro intero
      prima di scoprirlo da solo.

      Il dettaglio dello spike e la ragione della scelta stanno in
      `PORTING-D1-native-browser.md`. Non e' lavoro buttato: e' la prova che la
      strada costosa era percorribile, che e' cio' che rende difendibile aver
      preso quella economica.

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

- **D1 — Browser pane**: ⚠️ **REVERSAL (2026-06-29) → IMPLEMENTATO come WKWebView child + JS-injection, NON CEF.**
  Il pane Tauri spedito è una **child view WKWebView nativa** (`lib.rs` `browser_open`/`browser_navigate`/
  `browser_eval_js`/`browser_screenshot` via `takeSnapshot`), pilotata per **iniezione JS**, non CEF/CDP.
  CEF è stato **abbandonato** (nessuna dep `cef` in `Cargo.toml`). Differenze vs il piano CEF qui sotto:
  - **Parità agent 10/13 op** (aggiornato 2026-06-29): `NATIVE_SUPPORTED_OPS` in
    `client/src/lib/shell/tauriBrowserOps.ts` = **8 op native** (open / **observe** / **act** / **extract** /
    eval / get_text / console / screenshot — il loop DOM ref-based su cui è costruita l'intera tool-spec ora
    gira sul pane nativo, via injection delle STESSE `SNAPSHOT_FN`/`ACT_FN`/`EXTRACT_FN` del server) +
    **read_screen/point** via Moondream server-side sullo screenshot nativo (vedi
    [[project_tauri-browser-agent-parity]]). Restano **3 op deferred** — `save_state`/`load_state`/
    `import_chrome` (cookie httpOnly: serve objc write/delegate, non testabile a runtime) → fallback al path
    streaming/Playwright del server.
  - **Persi vs WebContentsView+CDP**: console-history early, input *trusted* (`isTrusted`), cookie httpOnly,
    nav-entries reali (back/forward menu è uno stub), eventi load nativi (url/title oggi via poll `eval` 800ms).
  - **Guadagnato**: leggerezza (niente bundle Chromium +170MB), nessun bundling `.app`/helper, vibrancy/glass
    nativi sotto il pane. Scelta deliberata Tier-1, non stopgap accidentale.
  - **Correzioni audit (verificate 2026-06-29)**: (a) il pane **NON** si ricarica al tab-switch — i pane
    visitati restano montati nella keep-alive ladder (`GroupLayout` `display:none`), quindi `browser_close`
    scatta solo alla chiusura reale → durabilità già ottenuta (l'audit l'aveva sovra-segnalato). (b) Il poll
    `eval` 800ms (url/title/loading + drain console) è **deliberato e commentato**; ritirarlo serve un bridge
    `WKNavigationDelegate`→eventi nativi + infra di event-listening lato client (oggi assente per scelta, no
    SDK `@tauri-apps`) + verifica a runtime → **DEFER**, non è un gap di correttezza.
  > Storico della decisione CEF originale (SUPERATA — tenuta solo per contesto):
  - Requisito utente: webview **reale** (DOM/scroll/interazione veri), non screencast.
  - Esito ricerca multi-agente (workflow `native-browser-pane-tauri`, 11 agenti):
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
  - ⚠️ **Blocco macOS confermato (2026-06-25)**: CEF su macOS **non gira come binario nudo**
    (`cargo build`/`cargo run`) — richiede la struttura `.app` con i sub-process helper
    (framework in `Contents/Frameworks` + eseguibili helper separati per render/gpu/utility).
    Lo spike CEF va fatto con `tauri build` + bundling custom del framework (es. crate
    `bevy_cef_bundle_app` come riferimento) + code-signing degli helper. È una **sessione
    dedicata**, non un'aggiunta in coda. Download distribuzione CEF ~1GB+.
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
- **D4 — Cap Electron "senza port Tauri" (audit 2026-06-29)**: l'audit segnalava 4 cap a zero
  impl Tauri. Verifica dei **consumer reali** → 2 sono falsi positivi, gli altri descope/defer:
  - `app.toggleAlwaysOnTop`: ✅ **GIÀ MIGRATO** (non era un gap). Funziona via nativo — global
    shortcut Cmd/Ctrl+Alt+T (`lib.rs` `GlobalShortcutBuilder`) + menu View ▸ Always on Top +
    stato `ALWAYS_ON_TOP`. Il renderer **non lo consuma né su Electron né su Tauri** (nessun
    `toggleAlwaysOnTop`/`getAlwaysOnTop` in `client/src`), quindi nessun command/facade da costruire.
  - `caffeinate` (powerSaveBlocker): ❌ **DESCOPE — API orfana**. `electronAPI.caffeinate` non è
    chiamato da nessuna parte (zero hit in `client/src` su Electron *e* Tauri). Non è una lacuna di
    parità: è una preload-API Electron mai consumata. Niente da portare finché non serve a un caller.
  - `notification.showScoped` (banner con **deep-link al topic on-click**): **DEFER** — `notify`
    base c'è; il valore (click→naviga) richiede le azioni del plugin notification + listener client +
    verifica live. Follow-up, non mezza-feature ora.
  - `daemon launchagent` (install/uninstall/status come servizio launchd): **DESCOPE → Tier 2**.
    È accoppiato alla topologia server (come il pty, D2); fuori scope Tier-1. Su web/mobile = no-op.
  - `multiwindow detach` (estrai un topic in finestra propria): **DEFER** (parità ridotta, non
    blocco). Tauri lo regge via `WebviewWindow` multiwindow + registry detached; sessione dedicata.
  → Lascia come unico P0 di parità l'**updater** (consumer vivo `UpdaterToast`, vedi sotto).

## 7. Hardening sicurezza config Tauri (da review)

Lo spike `desktop-tauri/` punta a `http://localhost:3333` con `csp: null` **solo per
misurare la RAM** contro il server live — config **throwaway, non di produzione**.
La config Tauri di produzione DEVE:
- Caricare gli asset **bundled** (`frontendDist` → `tauri://localhost`) o **https**, mai
  un origin `http` plaintext remoto.
- Impostare una **CSP stretta** (`app.security.csp`), non `null`.
- **Non esporre l'IPC Tauri** a origin remoti: `app.security.capabilities`/
  `dangerousRemoteDomainIpcAccess` lockati al solo origin dell'app.

### 7b. Audit config attuale (2026-06-29) — 1 solo gap residuo: `csp: null`

Verificata `tauri.conf.json` + `capabilities/default.json` del worktree: **conformi a §7 tranne la CSP**.
- ✅ `frontendDist: ../../public` → asset **bundled** (`tauri://localhost`), nessun origin http remoto. `devUrl` assente.
- ✅ IPC scoped: `windows: ['main']`, `remote` assente, **nessun** `dangerousRemoteDomainIpcAccess`. 9 permessi
  minimi (`core`/`opener`/`process`/`os`/`dialog:allow-open`/`updater:default`), nessun grant troppo largo.
- ⚠️ **`app.security.csp: null`** — unico gap. NON corretto alla cieca: una CSP errata rompe l'app (blocca
  inline-style/WS/data:) e non è verificabile a schermo bloccato → peggio di null. **CSP candidata** da testare
  (su Tauri il webview parla col proxy loopback `127.0.0.1:13333`, non :3333 diretto — vedi `lib/shell/net.ts`):
  ```
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';            // React/Tailwind + stili inline (incl. il FLIP imperativo)
  img-src 'self' data: blob: http://127.0.0.1:13333;
  font-src 'self' data:;
  connect-src 'self' http://127.0.0.1:13333 ws://127.0.0.1:13333;
  worker-src 'self' blob:;
  ```
  VERIFICA su sblocco: applicare, lanciare, controllare la console per violazioni CSP e allargare il minimo
  indispensabile (es. togliere `wasm-unsafe-eval` se nessun WASM lo richiede). Non spedire senza questo giro.

## 8. Follow-up audit deferiti (2026-06-29) — entry-point + verifica richiesta

Item che richiedono un **run Tauri live** (impossibile verificarli staticamente) o sono
"large". NON spedirli alla cieca: ognuno ha bisogno della verifica indicata.

1. **WKNavigationDelegate event bridge** (ritira il poll `eval` 800ms). Entry: il poll è in
   `client/src/hooks/useTauriBrowser.ts` (~riga 248); il pane WKWebView nasce in `lib.rs`
   `browser_open` via `WebviewBuilder`/`add_child`. Approccio: emettere eventi load nativi
   (Rust → `app.emit`) e ascoltarli lato client. BLOCCO: il client evita l'SDK `@tauri-apps`
   (no event-listening); o si aggiunge `@tauri-apps/api` solo per `listen`, o si tiene il poll
   per il drain console e si usano gli eventi solo per url/title/loading. VERIFICA: run Tauri,
   navigare un SPA e confermare niente lag address-bar + spinner reale. Tenere il poll come
   fallback finché non provato.
2. **Poll gating su visibilità** ✅ FATTO (commit `a1985516`): `useTauriBrowser` ora ricava un
   param `isVisible` (passato da `RemoteBrowserPanel`, stesso segnale dello screencast) e il poll
   800ms gira solo per il pane visibile; al ritorno-visibile l'effetto ri-parte e prime un tick.
3. **Browser-pane agent observe/act** (parità 5/13 → ~80%): un walker JS di accessibilità +
   ref-map iniettato, NON CEF. Entry: `NATIVE_SUPPORTED_OPS` in `lib/shell/tauriBrowserOps.ts`;
   contratto in `browser-tool-spec.ts`. QUANTIFICARE prima: input non-trusted perde i siti
   `isTrusted`-gated, no cookie httpOnly, `point`/`save_state` restano fuori. Decisione di
   prodotto + verifica con un agente reale su una pagina viva. WKUIDelegate per i permessi.
4. **Wiring `splitTreeEngine`** (P3/large): engine+adapter+golden-test pronti ma 3 comportamenti
   live (project GroupLayout, sub-stack, insert-between) restano su codice legacy, e il golden
   prova solo la geometria statica, non la parità di gesture. Prima del flip: wire (o cancella)
   `useSplitController`, unifica il floor `MIN_CHILD_WEIGHT`↔`MIN_PANE_FRACTION` (0.05→0.1) con
   aggiornamento dei golden test. VERIFICA: parità gesture drag/drop misurata, non solo statica.
5. **Spike `ghostty-web`** (fronte 2, opzionale): unico core WASM xterm-compatibile che tiene il
   modello canvas+DOM (no child-view nativa, no occlusione, agent-scrape preservato — API
   buffer/selection verificate 1:1). GATE UNICO: il suo canvas rende `rgba(0,0,0,0)` su `.chrome-glass`
   con glifi nitidi a 2× DPR? Untestabile dai doc → spike di 1-2 giorni dietro feature-flag su UN
   pane. Se la trasparenza fallisce, rigetta come xterm-WebGL. Pretendere l'API RenderState (non il
   viewport-grab per-riga). Priorità bassa: il terminale attuale è solido.

### 8b. FLIP push (60fps sidebar) — checklist di verifica LIVE (impl. `d5a25ed2`/`98823cc5`)

Spedito: `useSidebarFlipPush` sostituisce lo snap `manyTerminals` con un reveal FLIP
(commit del pad finale in 1 reflow + `transform:translateX` compositor-only sul flip layer).
Statico verde (tsc -b, vite prod build, 98 test). L'harness è cablato: `App.tsx` espone
`window.__topicsToggleSidebar` e `lib.rs FPS_SELFTEST_JS` lo pilota → riporta via `fps_report`.
**Sequenza di verifica (a schermo SBLOCCATO)**: (1) `/public` già rebuildato col FLIP; (2) rebuild
dell'app Tauri — l'`.app` embedda `/public` al build, quindi la `.app` in esecuzione (pid pre-FLIP) va
ricostruita: `cd desktop-tauri && cargo tauri build` (o lo script di prod); (3) relaunch con
`TOPICS_FPS_SELFTEST=1` (kill pid + open `.app`); (4) leggere il `fps_report`. Da confermare su build viva:
- **MECCANISMO — GIÀ PROVATO (lock-proof, `c977168c`)**: `performance/sidebar-flip-bench.html` misura il
  costo forced-reflow di paddingLeft (vecchio) vs transform (FLIP) con N terminali. Chromium 2026-06-29:
  paddingLeft 1.3/3.0/5.0ms median a N=2/5/8 (O(N), pagato OGNI frame); transform 0ms a ogni N (1300×–5000×).
  Engine-universale (padding=layout, transform=compositor su WebKit e Chromium). Conferma la causa radice + il fix.
- **HEADLINE COMPOSITATO — VERIFICATO lock-proof (headless Chromium, `performance/sidebar-flip-bench.html`)**:
  Chrome headless renderizza OFFSCREEN → i delta rAF durante l'animazione sono reali nonostante il display
  bloccato. N=16 terminali (~52k spans), durante i 200ms: **VECCHIO** paddingLeft = 41.9ms/frame median (~24fps),
  **6/6 frame >33ms = TUTTI persi** (combacia coi ~25fps WebKit documentati); **FLIP** transform = 8.3ms/frame
  median (~120fps), **0/31 frame >33ms = zero persi**. L'acceptance headline è raggiunta dal FLIP.
- **CONFERMA WebKit REALE — VERIFICATA lock-proof (`performance/sidebar-flip-webkit-bench.cjs`)**: forced-reflow
  in WebKit headless (Playwright, `AppleWebKit/605.1.15 Version/26.0` = stesso motore del WKWebView Tauri;
  timing layout sincrono, affidabile anche se headless WebKit throttla il rAF). paddingLeft = 8/20/**33**/66ms
  di layout PER FRAME a N=2/5/8/16 → a N=8 è **2× il budget di 16.7ms** (spiega i ~25fps); transform = **0ms a
  ogni N**. WebKit è ~6× più lento di Chromium nel layout → il FLIP conta di PIÙ sul motore reale.
- **CONFERMA finale su WKWebview di sistema (serve sblocco, confermativa)**: `TOPICS_FPS_SELFTEST` sull'app Tauri
  reale → 0 frame >33ms compositati + tracking pane nativo. Il costo engine è già provato su WebKit reale sopra.
- **Browser pane nativo (rischio portante)**: split con 1 terminale + 1 BROWSER pane, toggle
  sidebar → il bordo sinistro del pane deve tracciare il bordo contenuto in lockstep coi terminali,
  niente trail né salto-a-fine. Si regge su `getBoundingClientRect` post-transform (WebKit conforme)
  + lo slidePoll per-frame (NativeBrowserPlaceholder.tsx:285). FALLBACK se desincronizza: freeze-frame
  PNG (`browser.frozenImage`) per i 200ms — tiene il contenuto VISIBILE (bitmap fedele, non blank).
- **Toggle rapido** (collapse→expand a metà slide): nessun salto (First = rect live, re-basa).
- **Blur glifi**: con `will-change:transform` il sottoalbero (canvas terminali) è promosso a layer
  per 200ms → verificare che WebKit non rasterizzi a 1× (glifi sfocati durante la slide).
- **8-way split**: la slide è 60fps ma il settle-fit post-slide resta ~110-160ms (floor noto, NON
  un drop durante la slide) — è un piccolo snap di colonne a fine slide, atteso.
- **Electron/web**: spot-check che il push sia liscio e nulla "snappi"; il tracking del browser-pane
  Electron durante il FLIP non è coperto dal fallback freeze-frame (solo Tauri) → verificare a parte.
- **Floating-splits frost** (analizzato: dovrebbe comporsi BENE, no regressione attesa): `useFloatingVibrancy`
  triggera l'handoff nativo (`vibrancy_animate_regions`) sul `transitionrun` di **`width` della SIDEBAR**
  (`isSidebarWidth`, useFloatingVibrancy.ts:290) — NON sulla paddingLeft del contenuto, quindi il FLIP non
  rimuove il trigger. Al transitionrun il mio invert è già applicato (useLayoutEffect pre-paint), così
  `collect()` legge i rect VISIVI vecchi (post-transform), `predictSidebarEnd` calcola i finali e l'animazione
  nativa va old→finale in lockstep col reveal del transform (entrambi 200ms, curva matchata); il flush a
  `transitionend` corregge il drift sub-px. VERIFICA solo per conferma: in floating-splits il frost dei gap
  traccia i card durante i 200ms senza trail/salto.

---

## 9. Milestone: **Decommission `electron-app`** (Wave 7)

Con il cutover v2 (Tauri primaria) il decommission di `electron-app/` è una milestone
esplicita.

> **✅ ARCHIVIATO — 2026-07-02.** `electron-app/` + `release.yml`/`auto-tag.yml` +
> gli script di staging Electron rimossi da `main`; lo stato pre-rimozione (source
> completo + build machinery universale) è **recuperabile sul branch `electron-archive`**
> (a `c73907eb`). Gli installer `v*` esistenti restano scaricabili dalla Releases page ma
> non vengono più buildati. Wave completate: W-B (job Tauri in CI), W-C (plist prod
> Electron rimosso → prod = `com.armonia.topics-server` + Topics.app Tauri come login item),
> W-E (dogfood), W-F (rimozione + pulizia doc). **Restano aperte:** W-A e W-D sotto.

- [ ] **W-A — Server bundling in `tauri-release.yml`**: oggi la workflow builda solo il
      client (Vite → `public/`, embedded come `frontendDist`); il server Bun NON è
      impacchettato, quindi l'installer Tauri da solo non è standalone. Portare lo staging
      del runtime (bun+node+`node_modules`) nel bundle Tauri. _(Lo staging Electron di
      riferimento, `scripts/stage-server-dist.mjs`, vive ora sul branch `electron-archive`.)_
- [x] **W-B — Job Tauri in CI** (`ci.yml`): ✅ aggiunto il job `tauri` (macos-latest,
      Rust stable + `Swatinem/rust-cache`, `cargo check` su `desktop-tauri/src-tauri`),
      rimpiazza il vecchio typecheck Electron.
- [x] **W-C — Prod plist**: ✅ `com.armonia.topics-electron-prod` rimosso (plist + script).
      Produzione = launchd `com.armonia.topics-server` (:3333) + **Topics.app** (Tauri) come
      login item / autostart. Un plist launchd Tauri-first dedicato resta un follow-up
      opzionale (l'app Tauri si auto-avvia come login item).
- [ ] **W-D — Prima release `tauri-v2*` CI verificata**: tag `tauri-v2.0.0` (nessun tag
      `tauri-v*` esiste ancora) → draft release con installer 3-OS + `latest.json`;
      verifica manuale di install + auto-update signing.
- [x] **W-E — Dogfood week**: ✅ Tauri usata come shell primaria senza regressioni bloccanti
      (divergenze accettate in §10 escluse).
- [x] **W-F — Decommission**: ✅ vedi banner sopra (archiviato 2026-07-02, branch
      `electron-archive`).

## 10. Known divergences (accepted) — Tauri vs Electron

Differenze **note e accettate** della shell Tauri (WKWebView) rispetto a Electron.
**Non bloccano** il cutover v2 né il decommission; restano aperte come follow-up
opzionali:

- **Context menu nel browser pane** — niente menu contestuale nativo completo nel pane
  WKWebView (Electron lo aveva via webContents).
- **Download progress %** — i download dal pane non espongono la percentuale di
  avanzamento (Electron: `will-download` + progress).
- **Notification deep-link** — il click sul banner OS non naviga al topic
  (`notification.showScoped` DEFER, vedi §6 D4).
- **Find-in-page match counts** — la ricerca nella pagina non riporta il conteggio
  "n di m" delle occorrenze.
- **Native zoom** — niente controlli di zoom nativi per-webview (Cmd+/− a livello pane).
- **Pane devtools docked** — le devtools del pane nativo non si agganciano docked
  dentro la finestra (ispezione solo esterna, es. Safari Web Inspector).

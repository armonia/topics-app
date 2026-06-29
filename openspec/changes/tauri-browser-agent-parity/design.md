# Design — tauri-browser-agent-parity

## Contesto rilevante (codice esistente)

- **Delega Tauri**: `server/browser-tool-dispatcher.ts` (~135-137) intercetta
  `nativeDelegateRegistry.isDelegated(contextId)` PRIMA di qualsiasi path CDP/Playwright
  e inoltra l'**intera** tool-call al client via `delegateOp`
  (`server/browser-native-delegate.ts`) su `/ws/browser`. Il client la esegue in
  `useTauriBrowser` (~406-412) → `executeNativeBrowserOp`
  (`client/src/lib/shell/tauriBrowserOps.ts`).
- **Op native oggi**: `NATIVE_SUPPORTED_OPS` = open, eval, get_text(intera pagina),
  console, screenshot. Le altre 8 → `STREAMING_HINT`.
- **Comando Rust generico**: `browser_eval_js(id, js) -> String` (lib.rs ~1290,
  `eval_js_blocking`, ritorna il valore dell'**ultima espressione** — semantica REPL,
  come `replEvaluate`); `browser_screenshot(id) -> base64 PNG` (~1384,
  `takeSnapshotWithConfiguration`).
- **Modello snapshot (`server/browser-snapshot.ts`)**:
  - `SNAPSHOT_FN(opts)` è una funzione **interamente self-contained** (solo globali
    DOM): stampa `data-topics-ref="N"` su ogni elemento interattivo visibile e ritorna
    `Snapshot` (`{url,title,scrollY,scrollMaxY,elements:SnapElement[],truncated}`).
  - `serialize(snap)` e `diff(prev,next)` sono **funzioni pure** (nessuna dipendenza
    Playwright; l'unico import è `import type { Page }`, cancellato a build).
  - `actByRefOnPage`/`getTextOnPage`/`extractFieldsOnPage` operano su un `Page`
    Playwright (locator/evaluate) — questi sono il pezzo render-specifico.
- **Vincolo**: lo schema dei tool (`server/browser-tool-spec.ts`) NON cambia. Pane
  nativo e streaming devono restare intercambiabili per il chiamante.

## Problema centrale

Su Tauri la WKWebView non ha CDP, quindi il path server `resolveOps`→`cdpOps` non la
raggiunge mai; per i pane nativi tutto passa dalla delega client. Ma l'executor client
copre solo 5 op. Per dare all'agente il controllo del pane **visibile** servono le
op mancanti **dentro la delega**, riproducendo *byte-per-byte* le shape e il formato
testuale che l'agente già conosce — altrimenti l'esperienza dell'agente diverge tra
Electron e Tauri.

## Decisione chiave: CONDIVIDERE il core snapshot, non riscriverlo

`SNAPSHOT_FN` è serializzabile (`.toString()`) ed eseguibile via `browser_eval_js`;
`serialize`/`diff`/i tipi sono puri e importabili dal client. Quindi:

1. Estrarre il **core dependency-free** in un modulo condiviso
   `shared/browser-snapshot-core.ts` (o equivalente importabile da client e server):
   `SNAPSHOT_FN`, `serialize`, `diff`, `sig`, `line`, e i tipi `SnapElement` /
   `Snapshot` / `SnapshotDiff` / `RefAction` / `ExtractFields`. L'import
   `playwright-core` resta SOLO in `server/browser-snapshot.ts` (helper render-specifici),
   che re-esporta dal core per non rompere i chiamanti server.
2. L'executor nativo importa dal core. **Una sola sorgente del formato** → zero drift.

### Phase 1 — observe/act/extract/get_text(ref) nel client (no Rust, no CDP)

In `tauriBrowserOps.ts`, mantenere una cache per-pane `prevSnapshot: Map<id,Snapshot>`
(l'equivalente client di `prevSnapshotCache`):

- **`browser_observe`**: `js = "(" + SNAPSHOT_FN + ")(" + JSON.stringify({max}) + ")"`;
  `raw = await browser_eval_js(id, js)`; `next = JSON.parse(raw)`. Poi:
  - `full` richiesto o nessun prev → `serialize(next)`, `full:true`;
  - altrimenti `diff(prev, next).text`. Aggiorna `prevSnapshot`. Ritorna
    `{url,title,count:next.elements.length,snapshot,full}` — identico a
    `handleBrowserObserve`. (Lo `screenshot_annotated` opzionale è omesso nel pane
    nativo: l'utente già lo vede; documentato.)
- **`browser_act`**: validazione identica al server (REF_ACTIONS, text/value required).
  Iniettare un `ACT_FN(ref, action, payload)` self-contained che risolve
  `[data-topics-ref="N"]` e applica l'azione **in-page**:
  - `click/dblclick` → `el.click()` (×2 per dblclick) dopo `scrollIntoView`;
  - `hover` → `dispatchEvent(new MouseEvent('mouseover'/'mousemove',{bubbles:true}))`;
  - `fill` → `el.focus(); el.value=text; dispatch('input'); dispatch('change')`;
  - `type` → come fill ma char-by-char con eventi `input`;
  - `select` → set `el.value`/option + `dispatch('change')`;
  - `check/uncheck` → set `el.checked` + `dispatch('change')`;
  - `press` → `dispatchEvent(new KeyboardEvent('keydown'/'keyup',{key}))`;
  - `scroll` → `window.scrollBy(0, dy)`.
  Poi re-snapshot + `diff` → `{ok:true,action,ref,snapshot}`. **Ref stale** → errore
  identico al server ("call browser_observe again").
- **`browser_get_text(ref)`**: eval
  `document.querySelector('[data-topics-ref="N"]').innerText` (cap), normalizzato come
  `getTextOnPage`. Senza ref → comportamento attuale (intera pagina).
- **`browser_extract`**: iniettare la inner-fn di `extractFieldsOnPage` con `fields`
  inlinati → `{extracted}`.

**Limite documentato (trusted events)**: gli eventi sono sintetizzati in JS
(`isTrusted=false`), a differenza di Electron che usa CDP `Input.dispatchMouseEvent`
(trusted). Copre la stragrande maggioranza dei siti; alcuni input nativi (es. file
picker, framework che esigono `isTrusted`) possono differire. WKWebView non espone API
JS per eventi trusted → tradeoff accettato; in caso, l'utente abilita streaming.

### Phase 2 — vision read_screen/point sul pane nativo (server orchestra)

`browser_read_screen`/`browser_point` restano gestiti **server-side** ma alimentati
dallo screenshot nativo. Nel dispatcher: se il contesto è delegato e il tool ∈
{read_screen, point}, NON inoltrare l'intera call; invece delegare la sola op
`browser_screenshot` (già supportata) per ottenere il base64, poi far girare il layer
vision esistente (`handleBrowserReadScreen`/`handleBrowserPoint` →
Moondream `describeImage`/`pointObject`) su quell'immagine. `point` ritorna coordinate
→ per cliccare, si traduce in un `browser_act` per-ref se il punto cade su un elemento
snapshot, altrimenti in un eval `document.elementFromPoint(x,y).click()` (best-effort).

### Phase 3 — save/load/import state sul pane nativo (Rust cookie bridge)

- Nuovi comandi Rust: `browser_get_cookies(id) -> Json` e
  `browser_set_cookies(id, json)` su `WKHTTPCookieStore`
  (`WKWebsiteDataStore.default().httpCookieStore`, API async objc → completati su main
  thread come `eval_js_blocking`). `localStorage` via eval (dump/seed).
- **`browser_save_state`**: cookies (Rust) + localStorage (eval) → handle JSON.
- **`browser_load_state`**: setCookies (Rust) + seed localStorage (eval) + reload.
- **`browser_import_chrome`**: riusare l'**estrazione cookie Chrome lato server**
  (già presente per il path Electron CDP) per produrre la lista cookie, poi
  applicarla via `browser_set_cookies` — niente decifratura Keychain in Rust.

### Phase 4 — hardening navigazione/permessi (Rust)

- **Scheme-guard**: nel `nav-guard` (lib.rs ~1959) sostituire l'esenzione incondizionata
  dei pane (`if label != "main" { return true }`) con un check di scheme per i pane
  (allow http/https/about/data; nega file://, chrome://, ecc.), allineato a
  `AGENT_NAV_SCHEMES`/`guardNav` di Electron. Chiude l'LFI via
  `browser_eval` `window.location='file://…'`.
- **Permission delegate**: implementare il delegate WKWebView media-capture/geo →
  emettere un evento al client cablato alla `PermissionBar` esistente (oggi solo
  `electronAPI`); aggiungere il path Tauri (invoke `browser_respond_permission`).
- **window.open/close**: estendere lo script iniettato (`CONSOLE_PROXY_JS`, lib.rs ~865)
  con un override `window.close` che emette un sentinel → il client chiude il pane
  (come `onPageCloseRequest` di Electron); UI delegate `createWebViewWith` per
  `window.open`/`target=_blank` → naviga in-place + evento.
- **WKBackForwardList**: comando `browser_nav_entries(id) -> {entries,activeIndex}`
  da `backList`+`currentItem`+`forwardList`, e `browser_go_to_index(id, i)` via
  `go(to:)`. `getNavEntries` (oggi stub) lo invoca → popola il dropdown.

## Alternative scartate

- *Ri-portare il walker nel client a mano*: rischio drift del formato snapshot/diff
  (l'agente parsa testo specifico). Scartata a favore della condivisione del core.
- *Esporre CDP sulla WKWebView*: WKWebView non ha CDP; impossibile senza embeddare
  un altro engine (cef-spike scartato altrove). Scartata.
- *Far guidare all'agente il Chromium streaming di default*: è un browser **diverso**
  (profilo/login separati) che l'utente non vede → rompe l'invariante "l'agente guida
  il pane visibile". Lo streaming resta opt-in.
- *Re-implementare la decifratura cookie Chrome in Rust*: duplicazione fragile;
  meglio riusare l'estrazione server esistente (Phase 3 import_chrome).

## Test

- `bun:test` (puro, co-locato): `tauriBrowserOps` con `invoke` iniettato — observe
  serializza come `serialize`/`diff` su uno snapshot fixture; act valida ref/azioni e
  costruisce l'`ACT_FN` atteso; extract mappa i campi. Più un test che `SNAPSHOT_FN`
  condiviso produce lo stesso output del server su un DOM jsdom-like (o snapshot fixture).
- Playwright E2E: pane browser nativo (Tauri) — observe→act(click)→snapshot diff su una
  pagina locale; non testabile il path Tauri puro in CI headless → smoke manuale sul
  binario debug.

## Rollout

- **Client**: `vite build` → `/public` (asset-watcher ricarica Electron/Tauri debug).
- **Server** (Phase 2): `kickstart -k` di `com.armonia.topics-server`.
- **Rust** (Phase 3-4): rebuild binario Tauri — debug per iterare (disk + hot-reload),
  `cargo build --release` per la build vera quando approvato.
- Fasi indipendenti e mergeabili una alla volta quando verdi (tsc + build) — la Phase 1
  da sola chiude il gap HIGH.

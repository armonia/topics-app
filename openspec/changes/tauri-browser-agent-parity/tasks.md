# Tasks — tauri-browser-agent-parity

## 1. Core snapshot condiviso (fondazione Phase 1)
- [x] 1.1 Estrarre il core dependency-free in `shared/browser-snapshot-core.ts` (importabile da client+server): `SNAPSHOT_FN`, `serialize`, `diff`, `sig`, `line`, tipi `SnapElement`/`Snapshot`/`SnapshotDiff`/`RefAction`/`ExtractFields` + `ACT_FN`/`EXTRACT_FN`. Nessun import `playwright-core` nel core.
- [x] 1.2 `server/browser-snapshot.ts` re-esporta dal core e tiene solo gli helper render-specifici (`snapshotPage`/`actByRefOnPage`/`getTextOnPage`/`extractFieldsOnPage`/`evalOnPage`). `typecheck:server` verde (0 errori), nessun chiamante rotto.

## 2. Phase 1 — observe/act/extract/get_text(ref) nativi (client-only)
- [x] 2.1 In `tauriBrowserOps.ts`: cache per-pane `prevSnapshot: Map<id,Snapshot>` + `clearNativeSnapshotCache`; helper `takeSnapshot` che inietta `SNAPSHOT_FN` via `browser_eval_js` e fa `JSON.parse`.
- [x] 2.2 `browser_observe`: serialize (full/no-prev) o `diff(prev,next).text`; ritorna `{url,title,count,snapshot,full}` (shape identica a `handleBrowserObserve`).
- [x] 2.3 `browser_act`: validazione identica al server (REF_ACTIONS, text/value required, azioni valide); `ACT_FN` iniettato che risolve `[data-topics-ref]` e applica click/dblclick/hover/fill/type/select/check/uncheck/press/scroll; ref-stale → errore identico; re-snapshot+diff → `{ok,action,ref,snapshot}`.
- [x] 2.4 `browser_get_text(ref)`: eval su `[data-topics-ref="N"]`.innerText, normalizzato; senza ref → intera pagina (comportamento attuale).
- [x] 2.5 `browser_extract`: `EXTRACT_FN` (inner-fn di `extractFieldsOnPage`) con `fields` inlinati → `{extracted}`; coercizione legacy `schema.properties`.
- [x] 2.6 Aggiornato `NATIVE_SUPPORTED_OPS` con observe/act/extract; rimosso l'hint streaming per queste; aggiornato il commento header del file.

## 3. Phase 2 — vision read_screen/point sul pane nativo (server)
- [x] 3.1 In `server/browser-tool-dispatcher.ts`: `nativeVisionOp` — per contesto delegato + tool ∈ {browser_read_screen, browser_point}, delega la sola op `browser_screenshot`, poi `describeImage`/`pointObject` (Moondream) su quell'immagine. Aggiunto param `mime` al moondream-client (lo screenshot nativo è PNG, non jpeg). Verificato live: API Moondream caption+point HTTP 200, key valida.
- [x] 3.2 `browser_point`: viewport via eval `innerWidth/innerHeight` (coord normalizzate → DPR irrilevante); click via `document.elementFromPoint(x,y).click()` (best-effort, WKWebView non ha input trusted).

## 4. Phase 3 — save/load/import state nativo (Rust cookie bridge) — DIFFERITA
- [ ] 4.1 lib.rs: `browser_get_cookies(id)`/`browser_set_cookies(id,json)` su `WKHTTPCookieStore`.
- [ ] 4.2 Executor: `browser_save_state` = cookies + localStorage(eval); `browser_load_state` = setCookies + seed + reload.
- [ ] 4.3 `browser_import_chrome`: riusa l'estrazione cookie Chrome server-side → `browser_set_cookies`.
- **NOTA**: differita di proposito. Il SET cookie è objc write-side con dict di proprietà NSHTTPCookie (costanti globali `NSHTTPCookie*`) + completion handler async: `cargo check` verifica la compilazione ma NON il runtime (un selettore sbagliato compila e crasha a runtime), e qui non si può testare sul device. Per restare "solido e stabile" va implementata con smoke-test sul binario.

## 5. Phase 4 — hardening navigazione/permessi (Rust)
- [x] 5.1 Scheme-guard per-pane nel `nav-guard` (lib.rs): per i webview `browserpane-*` allow solo http/https/about/blob/data, nega file://, chrome://, view-source:. Chiude l'LFI via `browser_eval window.location='file://'`. `cargo check` verde.
- [ ] 5.2 Permission delegate WKWebView (camera/mic/geo) → `PermissionBar`. **DIFFERITA**: richiede una subclass `WKUIDelegate` registrata via objc `ClassDecl` (runtime non testabile qui).
- [ ] 5.3 window.open/close (popup OAuth). **DIFFERITA**: la semantica corretta dei popup richiede il UI-delegate `createWebViewWith`; un override JS di `window.open`/`close` è un footgun (chiuderebbe l'intero pane su un OAuth in-place).
- [x] 5.4 `browser_nav_entries(id)`/`browser_go_to_index(id,i)` da `WKBackForwardList` (lib.rs, objc read-only, selettori WebKit documentati); `getNavEntries`/`goToNavIndex` (useTauriBrowser) li invocano → dropdown cronologia popolato. `cargo check` + tsc + build verdi.

## 6. Tests
- [x] 6.1 `bun:test` co-locato `tauriBrowserOps.test.ts`: observe serializza come `serialize`/`diff` su snapshot fixture; act valida ref/azioni; extract mappa campi; parità output via core condiviso. 17/17 verdi.
- [ ] 6.2 Playwright E2E (best-effort sul binario debug Tauri): observe→act(click)→diff su pagina locale.

## 7. Verify
- [x] 7.1 Phase 1: `tsc -b` (client) + `typecheck:server` verdi (0 errori); `build:client` → `/public` ok. (`cargo check` N/A in Phase 1 — nessun Rust.)
- [x] 7.2 Schema tool invariato: `browser-tool-spec.ts` non modificato; le op native ritornano le stesse shape degli handler server (`{url,title,count,snapshot,full}`, `{ok,action,ref,snapshot}`).
- [ ] 7.3 Smoke sul binario debug: l'agente fa observe→act→extract sul pane visibile; save/load_state preserva un login; scheme-guard blocca file://.
- [ ] 7.4 Review avversariale sul diff (fedeltà serialize/diff, ref stale, trusted-event, LFI chiusa).

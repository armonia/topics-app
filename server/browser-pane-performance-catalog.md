# Browser pane — catalogo ottimizzazioni performance ("top")

> Subtask #4 del task *"Browser pane: readiness da IDE a browser completo"*.
> Catalogo grounded sul codice reale (branch `topics/doleful-ghost`). Ogni leva ha:
> costo/beneficio, dove tocca, e come si misura. Ordinate per rapporto valore/rischio.
>
> Convenzione: **[LANDABILE]** = fattibile e verificabile senza GUI Tauri viva ·
> **[LIVE]** = richiede l'app viva per la verifica end-to-end.

## 0. Contesto misurato

- Il pane nativo (macOS) è una `WKWebView` figlia guidata da Rust (`desktop-tauri/src-tauri/src/lib.rs`),
  pilotata lato client da `client/src/hooks/useTauriBrowser.ts`.
- Lo stato di navigazione (url/title/favicon/loading/console/self-focus) NON arriva da
  eventi nativi: è **polled** con `browser_eval_js` ogni **800 ms** quando il pane è
  in foreground (`useTauriBrowser.ts:532`), + un poll lento **2.5 s** per i tab in
  background. Il tick è già gated su `isVisible` e su `inFlight` (niente pile-up).
- Il sidecar Chromium on-demand (engine switch, subtask #1) è ref-counted / idle-reap
  (`server/browser-chromium-sidecar.ts`) → zero processi finché un pane non passa a
  `chromium`.

## 1. Pane browser — le leve col miglior rapporto valore/rischio

### 1.1 Sostituire il poll 800 ms con eventi di navigazione nativi  **[LIVE]**
- **Oggi:** ogni 800 ms un `browser_eval_js` fa un round-trip JS→Rust→JS anche su pagina
  ferma. Su N pane visibili = N eval/800ms, ognuno occupa uno `spawn_blocking` worker.
- **Fix strutturale:** WKWebView espone `WKNavigationDelegate`
  (`didCommit`, `didFinish`, `didFailProvisionalNavigation`) + KVO su
  `url`/`title`/`estimatedProgress`/`canGoBack`/`canGoForward`. Emettere questi come
  eventi Tauri e rimuovere il poll. Il favicon e il self-focus counter restano
  via userscript (`initialization_script`), ma **pushati** (message handler) invece di
  pollati.
- **Beneficio:** ~0 lavoro su pagina idle (oggi ~75 eval/min per pane), latenza di
  aggiornamento URL/spinner da ≤800ms a immediata, un `spawn_blocking` in meno occupato.
- **Misura:** idle-CPU del processo app con 1 pane fermo su una pagina statica, prima/dopo
  (target: sparizione del tick periodico dal profiler). `find match-count` incluso qui:
  `WKWebView.find(_:configuration:)` restituisce già i match, oggi non esposto.

### 1.2 Sospendere i pane nascosti  **[LIVE]**
- **Oggi:** il fast-poll è già off quando `!isVisible`; resta il poll lento 2.5s per il
  label. Le webview nascoste restano però vive e possono animare/eseguire timer JS.
- **Fix:** su hide, `WKWebView` → `setValue(false, forKey:"drawsBackground")` non basta;
  usare la sospensione del rendering (pane fuori dal layout tree già smonta il placeholder)
  e, per il tab in background, fermare anche gli userscript timer. Con gli eventi nativi
  di §1.1 il poll lento sparisce del tutto (il title arriva da `didFinish`).
- **Beneficio:** niente CPU/GPU per tab non visibili; il costo scala col numero di tab,
  non col numero di tab *aperti*.

### 1.3 LRU cap dei webview vivi + freeze a bitmap  **[LIVE]**
- **Oggi:** ogni tab browser mai chiuso tiene viva la sua WKWebView (RAM per-tab).
- **Fix:** tenere vive al massimo K webview (foreground + MRU); i tab oltre K vengono
  "frozen" a snapshot bitmap (`WKWebView.takeSnapshot`) e ricreati al re-focus dallo
  `last-url.json` già persistito per contesto. Preserva la sessione (già per-topic),
  libera RAM/GPU.
- **Beneficio:** RAM del pane con tetto costante invece che lineare nei tab aperti.
- **Rischio:** perdita di stato in-page volatile (form non inviati) sul tab congelato →
  freezare solo tab idle da > T e mai quello con input focus.

### 1.4 Process-pool / dataStore condivisi  **[LIVE]**
- Usare un `WKProcessPool` condiviso e un `WKWebsiteDataStore` per-topic (non per-pane)
  riduce i processi WebContent e condivide cache/cookie coerentemente col contesto già
  persistito. Verificare che non rompa l'isolamento login per-topic (memory:
  *browser-login-lost-safestorage*).

## 2. Engine Chromium (sidecar) — perf specifica

### 2.1 Istanza condivisa + screencast adattivo  **[LIVE]**
- Il sidecar (`server/browser-chromium-sidecar.ts`) è già single-flight e ref-counted:
  un solo processo Chromium serve tutti i pane in modalità `chromium` (target condivisi,
  non un browser per pane).
- **Screencast:** `Page.startScreencast` con `everyNthFrame`/`quality` **adattivi** —
  alto framerate solo sul pane in foreground e interagito, throttle aggressivo su
  hover/idle, stop su hidden. Evita di pagare encoding JPEG per pane fermi.
- **Misura:** CPU del processo Chromium con 1 pane fermo vs. interagito.

### 2.2 Idle-reap già presente — verificare la soglia  **[LANDABILE]**
- Il lifecycle chiude il sidecar al rilascio dell'ultimo ref con idle-reap; la soglia va
  scelta per bilanciare "riapri veloce" vs "non tenere 300MB per nulla". Coperto dai test
  esistenti (`browser-chromium-sidecar.test.ts`).

## 3. RAM app (Tier 2/3) — fuori dal pane ma nel budget "top"

### 3.1 Server Bun in-process + `rusqlite`  **[LIVE]**
- Spostare l'accesso DB nel processo Rust con `rusqlite` invece del server Bun separato
  fa risparmiare ~un runtime JS (stima storica ~−61MB RSS). Grosso, invasivo: da fare
  come tornata dedicata, non dentro questo task.

### 3.2 Code-split / lazy dei pesi morti  **[LANDABILE — già in buono stato]**
- **Verificato:** `Terminal`, `FilePane`, `CodeEditor` sono già `React.lazy`; `manualChunks`
  separa già markdown/editor/icons (`client/vite.config`). Le ottimizzazioni ovvie sono
  fatte. Il grasso rimanto va **misurato** col size-report del build (`vite build` →
  rollup output), non indovinato. → azione: aggiungere il report al budget CI (§5).

### 3.3 Audit idle-CPU  **[LANDABILE parziale]**
- Diversi `setInterval(…, 1000)` in UI (SystemStatusPanel, SessionActivity, Board force-
  refresh ×2). Individualmente cheap, ma su app aperta a lungo sono wakeup costanti →
  gating su `document.visibilityState`/window focus dove il valore non serve in
  background.

## 4. Startup & rendering

- **Startup:** deferire l'init non critico oltre il first paint; warm lazy del pool
  webview solo dopo il primo frame. **[LIVE]**
- **Rendering:** virtualizzare le liste lunghe (history sessione, board con molte card);
  FLIP già usato sulla sidebar → audit degli altri hotspot con il perf monitor già
  presente (FPS dropdown / `fpsMonitor`). **[LIVE]**

## 5. Guardrail — budget in CI  **[LANDABILE]**
- **Bundle-size budget:** far fallire la CI se un chunk supera una soglia (rollup
  `output` + una soglia per-chunk). Impedisce regressioni di peso silenziose.
- **Smoke RAM/idle-CPU:** riusare i bench già presenti per un check RSS/idle-CPU
  post-boot con 1 pane fermo, con soglia. Aggancia le leve §1.1/§1.2/§3.3 a un numero.

---

## Ordine di esecuzione consigliato

1. **§1.1 nav via delegate nativo** — sblocca §1.2 e chiude il grosso del subtask #3
   (rimuove il poll, dà `find` match-count, back/forward reali). Massimo valore.
2. **§1.2 sospensione hidden** (cade quasi gratis dopo §1.1).
3. **§5 budget CI** (LANDABILE, protegge il resto).
4. **§1.3 LRU + freeze**, **§2.1 screencast adattivo** (perf sidecar), poi §3/§4 come
   tornate dedicate.

> Nota ambiente: le voci **[LIVE]** vanno implementate e verificate sull'app Tauri viva
> (guida del pane + profiler), non disponibile in questo worktree headless. Questo
> catalogo è il deliverable statico del subtask #4; le voci **[LANDABILE]** (§2.2, §3.2,
> §5) sono quelle attaccabili subito senza GUI.

# Tasks — per-pane-resource-usage

Convenzione: ogni fase chiude con `bun run typecheck:server` + `bun run typecheck:client`
+ i test della fase verdi. `[ ]` = da fare.

Le fasi 1 e 2 sono indipendenti: il lato server dà già un tooltip utile su terminali e
chat anche prima che la shell sappia attribuire le webview.

## Phase 1 — Attribuzione lato server (RES-ATTR-01) — FATTA
- [x] 1.1 Nessun registro nuovo da costruire: `routes/terminal.ts` tiene già `ptyPid`
  per sessione (il bridge lo riporta su create e reconcile). Esposto con
  `getFleetSessionRefs()` — TUTTE le sessioni, non solo le Claude come fa
  `getClaudeSessionsForDetection`: anche una shell consuma.
- [x] 1.2 `fleet-usage.ts`: `sessions[]` accanto a `roots[]`, con un `billed` PROPRIO
  invece di riusare `counted` — riusarlo avrebbe sottratto pid ai root e cambiato i
  totali di barra. Registrazione via seam (`registerFleetSessionSource`) per non
  chiudere il ciclo di import con `routes/terminal.ts`.
- [x] 1.3 `makeInstantCpu` restituisce `null` per un pid senza base: i totali continuano
  a trattarlo come 0 (come sempre), le sessioni lo dichiarano non misurato.
- [x] 1.4 Test dedicato che confronta i totali con e senza sessioni registrate: identici.
  22 test verdi, `typecheck:server` e `typecheck:client` a 0.

## Phase 2 — Attribuzione lato shell (RES-ATTR-02) — FATTA
- [x] 2.1 `-[WKWebView _webProcessIdentifier]`, verificata sul runtime PRIMA di
  scriverci sopra (era l'incognita che poteva far cadere la fase): il selettore esiste,
  ritorna un `int`, e due webview distinte danno due pid distinti, entrambi
  `com.apple.WebKit.WebContent`. È SPI → `respondsToSelector` a ogni giro, e l'assenza
  degrada a mappa vuota: si perde l'attribuzione per scheda, non la misura complessiva.
  Prima del caricamento ritorna 0, che non entra mai nella mappa — di qui lo stato
  "non ancora misurata" per una scheda appena aperta.
- [x] 2.2 `webviews[]` in `PerfMetrics`: label, pid, `phys_footprint` in MB (stessa
  metrica dei totali) e `cpu_percent: Option` — `None` = non misurata, non zero.
  La raccolta è asincrona per forza (`with_webview` gira sul main thread), quindi
  scrive per il giro successivo: la copertura si dichiara con la lista vuota.
- [x] 2.3 Quattro test Rust: pid morto escluso, ordine stabile fra due letture, mappa
  vuota che non diventa una lista di zeri, puntatore nullo che non fa crashare la SPI.
  Serializzati con un lock — condividono la mappa statica e `cargo test` va in
  parallelo (due rossi intermittenti alla prima stesura).

## Phase 3 — Canale unico e tipi (RES-ATTR-01/02) — FATTA
- [x] 3.1 `lib/paneUsage.ts`: store condiviso con cache, dedup e finestra allineata a
  `FLEET_TTL_MS`. NON `useSystemStatus`, che fa un `setInterval` per istanza —
  `PaneTabBar` è montata una volta per gruppo, quindi riusarlo avrebbe moltiplicato le
  fetch per il numero di gruppi (RES-ATTR-04). Nessun polling: si aggiorna su hover.
- [x] 3.2 Tipi in `useSystemStatus.ts` con `cpuPercent: number | null`.
- [x] 3.3 Le due sorgenti unite nello stesso store, sulle stesse unità: terminali per
  sessione, pane browser per label di webview (`browserpane-<paneId>`). Sono due mondi
  separati — il server non vede le webview, la shell non vede i sidecar — e una che
  cade non porta giù l'altra.

## Phase 4 — Tooltip (RES-ATTR-03, RES-ATTR-05) — FATTA
- [x] 4.1 Il tooltip va sul LABEL, non sulla tab: il contenitore usa apposta
  `aria-label` e non `title` (`PaneTabBar.tsx:941`), e il vincolo è stato rispettato.
  Il label un title non ce l'aveva e tronca il nome a 150px, quindi serviva già di suo.
- [x] 4.2 Tre stati distinti, con test dedicati che vietano lo zero nei primi due.
- [x] 4.3 E2E in `tests/e2e/pane-usage-tooltip.spec.ts`, deterministico (2,9 s). NON
  verifica il consumo vero — dipende dal carico e sarebbe rosso a caso — ma le due cose
  che gli unit test non possono vedere: che il `title` arrivi davvero nel DOM con la
  riga di consumo, e che stia sul NOME e non sul contenitore della tab. Quest'ultima è
  una regressione di design: il contenitore usa apposta `aria-label` e non `title`, e
  spostarlo là romperebbe il vincolo in silenzio.

## Phase 5 — Costo (RES-ATTR-04) — FATTA
- [x] 5.1 Il numero di letture non dipende dal numero di pane: lo store deduplica su
  `inFlight` e rispetta la finestra di validità. Test: venti tab che chiedono nello
  stesso istante producono UNA richiesta; dieci chiamate dentro la finestra, zero
  richieste in più.
- [x] 5.2 Coperti anche i modi in cui si rompe: una richiesta fallita libera `inFlight`
  (altrimenti nessun tentativo successivo partirebbe più), e un errore di rete tiene
  l'ultimo dato buono invece di svuotare il tooltip.

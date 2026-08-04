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

## Phase 2 — Attribuzione lato shell (RES-ATTR-02)
- [ ] 2.1 Associare ogni processo WKWebView al `label` della sua pane. Metà del lavoro
  c'è già: le pane browser sono webview NATIVE create con un label esplicito
  (`WebviewBuilder::new(&label, …)`, `lib.rs:3548`), quindi il nome esiste — manca il
  legame label → pid dell'XPC, che non è figlio della shell. Resta il pezzo con più
  incognite e va verificato **prima** di scrivere il resto; se la piattaforma non lo
  consente in modo stabile, la change si ferma alla Phase 1 e le pane browser dicono
  "non misurato" (RES-ATTR-02), che è già previsto.
- [ ] 2.2 Esporre footprint + CPU per pane, con la copertura dichiarata
  (`sampled`/`total` come già fa `cpu_sampled`/`cpu_pids`).
- [ ] 2.3 Unit test Rust sulla mappatura, con l'insieme dei processi iniettato.

## Phase 3 — Canale unico e tipi (RES-ATTR-01/02) — FATTA per il lato server
- [x] 3.1 `lib/paneUsage.ts`: store condiviso con cache, dedup e finestra allineata a
  `FLEET_TTL_MS`. NON `useSystemStatus`, che fa un `setInterval` per istanza —
  `PaneTabBar` è montata una volta per gruppo, quindi riusarlo avrebbe moltiplicato le
  fetch per il numero di gruppi (RES-ATTR-04). Nessun polling: si aggiorna su hover.
- [x] 3.2 Tipi in `useSystemStatus.ts` con `cpuPercent: number | null`.
- [ ] 3.3 Unire il lato shell quando la Phase 2 atterra (oggi le pane browser cadono in
  "non ancora misurato", che è il comportamento previsto).

## Phase 4 — Tooltip (RES-ATTR-03, RES-ATTR-05) — FATTA
- [x] 4.1 Il tooltip va sul LABEL, non sulla tab: il contenitore usa apposta
  `aria-label` e non `title` (`PaneTabBar.tsx:941`), e il vincolo è stato rispettato.
  Il label un title non ce l'aveva e tronca il nome a 150px, quindi serviva già di suo.
- [x] 4.2 Tre stati distinti, con test dedicati che vietano lo zero nei primi due.
- [ ] 4.3 E2E su due pane con consumi diversi. Rimandato di proposito: serve una
  sessione PTY viva con carico misurabile, che è un test lento e ballerino finché il
  campione CPU dipende da una finestra reale. Gli unit test coprono i tre stati e il
  formato; l'E2E aggiungerebbe soprattutto copertura del rendering.

## Phase 5 — Costo (RES-ATTR-04) — FATTA
- [x] 5.1 Il numero di letture non dipende dal numero di pane: lo store deduplica su
  `inFlight` e rispetta la finestra di validità. Test: venti tab che chiedono nello
  stesso istante producono UNA richiesta; dieci chiamate dentro la finestra, zero
  richieste in più.
- [x] 5.2 Coperti anche i modi in cui si rompe: una richiesta fallita libera `inFlight`
  (altrimenti nessun tentativo successivo partirebbe più), e un errore di rete tiene
  l'ultimo dato buono invece di svuotare il tooltip.

# Tasks — per-pane-resource-usage

Convenzione: ogni fase chiude con `bun run typecheck:server` + `bun run typecheck:client`
+ i test della fase verdi. `[ ]` = da fare.

Le fasi 1 e 2 sono indipendenti: il lato server dà già un tooltip utile su terminali e
chat anche prima che la shell sappia attribuire le webview.

## Phase 1 — Attribuzione lato server (RES-ATTR-01)
- [ ] 1.1 Registro sessione → pid di testa nel pty-bridge, con rimozione alla chiusura
  (una mappa che cresce quanto le sessioni mai aperte è la stessa perdita che
  `PERF_CPU_PREV` pota a ogni giro in `lib.rs`).
- [ ] 1.2 `fleet-usage.ts`: attribuzione per sessione accanto a quella per `kind`,
  riusando `counted` perché un pid resti fatturato una volta sola. Unit test sulla
  tabella sintetica già in `fleet-usage.test.ts`: due sessioni distinte, un pid
  condiviso, e la somma delle sessioni uguale al totale del root.
- [ ] 1.3 CPU non misurata distinta da zero per una sessione appena nata (stessa regola
  di `makeInstantCpu`). Unit test.
- [ ] 1.4 Verifica che i totali di flotta siano invariati: gli assert esistenti su
  `processCount`/`memoryMB`/`cpuPercent` devono restare verdi senza modifiche.

## Phase 2 — Attribuzione lato shell (RES-ATTR-02)
- [ ] 2.1 Associare ogni processo WKWebView al `label` della finestra/pane che lo ospita.
  È il pezzo con più incognite: un XPC non è figlio della shell. Da verificare **prima**
  di scrivere il resto, e da scartare presto se la piattaforma non lo consente in modo
  stabile — in quel caso la change consegna solo la Phase 1 e il tooltip copre terminali
  e chat, dicendo "non misurato" sulle pane browser.
- [ ] 2.2 Esporre footprint + CPU per pane, con la copertura dichiarata
  (`sampled`/`total` come già fa `cpu_sampled`/`cpu_pids`).
- [ ] 2.3 Unit test Rust sulla mappatura, con l'insieme dei processi iniettato.

## Phase 3 — Canale unico e tipi (RES-ATTR-01/02)
- [ ] 3.1 Unire le due metà in un solo payload per pane, sulle unità già in uso: CPU
  scala 0-100 della macchina, memoria `phys_footprint`.
- [ ] 3.2 Tipi in `useSystemStatus.ts`, con lo stato "non misurato" rappresentabile
  (non un `0` di comodo).

## Phase 4 — Tooltip (RES-ATTR-03)
- [ ] 4.1 Tooltip in `PaneTabBar.tsx` con memoria, CPU e numero di processi. Attenzione
  al vincolo già scritto nel file (riga ~903): su alcune tab un `title` aprirebbe un
  tooltip sopra un nome già visibile — va rispettato invece di sovrascritto.
- [ ] 4.2 Stato "non misurato" esplicito, mai uno zero.
- [ ] 4.3 E2E: due pane con consumi diversi mostrano due tooltip diversi; una pane appena
  aperta mostra "non misurato".

## Phase 5 — Costo (RES-ATTR-04)
- [ ] 5.1 Verificare che il numero di letture di sistema per ciclo non dipenda dal numero
  di pane: stesso `ps`, stesso `FLEET_TTL_MS`.
- [ ] 5.2 Misura prima/dopo con dieci pane aperte, allegata alla consegna.

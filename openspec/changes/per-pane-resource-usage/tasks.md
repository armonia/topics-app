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

## Phase 3 — Canale unico e tipi (RES-ATTR-01/02)
- [ ] 3.1 Unire le due metà in un solo payload per pane, sulle unità già in uso: CPU
  scala 0-100 della macchina, memoria `phys_footprint`.
- [ ] 3.2 Tipi in `useSystemStatus.ts`, con lo stato "non misurato" rappresentabile
  (non un `0` di comodo).

## Phase 4 — Tooltip (RES-ATTR-03, RES-ATTR-05)
- [ ] 4.1 Tooltip in `PaneTabBar.tsx` con memoria, CPU e numero di processi. Attenzione
  al vincolo già scritto nel file (riga ~903): su alcune tab un `title` aprirebbe un
  tooltip sopra un nome già visibile — va rispettato invece di sovrascritto.
- [ ] 4.2 TRE stati distinti, mai collassati in un "0" o un "—": misurato, "non
  misurato" (ha un processo, manca la misura), "senza processo proprio" (topic, kanban,
  chat, file, editor — vivono nel renderer condiviso e non sono separabili).
- [ ] 4.3 E2E: due pane con consumi diversi mostrano due tooltip diversi; una pane appena
  aperta mostra "non misurato".

## Phase 5 — Costo (RES-ATTR-04)
- [ ] 5.1 Verificare che il numero di letture di sistema per ciclo non dipenda dal numero
  di pane: stesso `ps`, stesso `FLEET_TTL_MS`.
- [ ] 5.2 Misura prima/dopo con dieci pane aperte, allegata alla consegna.

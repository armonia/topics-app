# Tasks: mac-usabile-sotto-carico

Ogni tornata è una PR a sé, con test che vanno rossi senza la correzione,
verifica avversaria e CI verde prima del merge. I test pesanti (suite unit,
e2e, typecheck completo) girano in CI o sul PC, mai sul Mac mentre è in swap.

## Tornata 1: coda senza tempesta
- [x] Un resume trattenuto riscrive `dispatch_state`/`dispatch_error` e trasmette `task:updated` solo quando il motivo cambia (tipo di blocco, testo a numeri esclusi, e per il pavimento la sola risorsa Memoria/Disco), con un rinfresco al massimo ogni 60 s dei numeri
- [x] Test: 7 card trattenute per 2 minuti di retry con il compositore vero e letture a cavallo di 6,0 GB producono al massimo 2 frame per card, e un cambio di tipo di blocco o di risorsa arriva subito

## Tornata 2: e2e degli agenti in CI
Disegno, file per file e test con i mutanti: `design.md` (sezione «Tornata 2»); delta in
`specs/kanban` (KANBAN-15, KANBAN-84) e `specs/quality-gates` (GATE-11).
- [x] Envelope (`buildKickoff`, `CODE_GATES_RULE`) e `docs/board-protocol.md`: niente `check:e2e-touched`, `playwright test` o build del client per gli e2e sul Mac; l'agente scrive lo spec e la prova arriva dalla CI
  - [x] `CODE_GATES_RULE` «E2E NEVER RUNS ON THIS MACHINE», per ogni board, con `bun test <file>` mirato ammesso; il ramo video di `PREVIEW_RULE` non manda più a una clip Playwright
  - [x] Con la riga dichiarata: `buildKickoff` e fan-out tolgono `github-ci:e2e` dai comandi e dicono la meccanica della CI; `board-protocol-parity` ancora le due regole
- [x] Il check `e2e-touched` della board prende l'esito dalla CI del commit consegnato, mai verde senza una corsa verde di quella testa (codice)
  - [x] 0.1 Credenziali dall'ambiente del server (PATH, HOME, SSH_AUTH_SOCK letti con `ps eww`): `git ls-remote`, `git push --dry-run --porcelain`, `gh auth status` escono 0 (15/09)
  - [x] `ChecksLane.release()` e `isOffLane` (`checks-gate.ts`); `E2E_CI_CHECK`, `isCiEvidenceCheck` (`shared/board.ts`); `server/services/ci-evidence.ts`; `runChecksGate` divide comandi e riga CI; formatter; `checksOffLane` nell'ammissione; `CHECKS_MAX_LEGS = 240`; cablaggio in `server.ts`
  - [x] Giro di correzioni della verifica: passo CI con `--unshallow` e uscita 2 senza merge base; lettore CI che lancia = non misurato; verdetto legato al commit misurato; `.personal-terms` letto dal checkout principale per la spinta da worktree; ramo video senza browser; riga «E2E IS NOT MEASURED BY THIS BOARD» per le board senza la riga
  - [x] Test 1-37 del design (`ci-evidence`, `checks-gate`, `tasks.checks-ci`, `review-checks`, `task-dispatcher-admission`, `task-dispatcher`, `board-protocol-parity`, `check-e2e-touched`)
  - [ ] Rollout, SOLO dopo il merge: `PATCH /api/boards/topics-app-ar3jt5/settings` con `{ "name": "e2e-ci", "cmd": "github-ci:e2e" }` al posto di `e2e-touched` e `&& bun run check:security --only=data,home,secrets` in coda a `static-rails`
  - [ ] La prima card consegnata dopo il PATCH: riga `e2e-ci` con PR e run in `checks_json`, bozza sul commit di `checks_commit`, nessun `playwright`/`chrome-headless-shell` fra i figli del server durante l'attesa
  - [ ] Il flusso di land riusa la bozza (`gh pr ready` più `gh pr edit`); le due memorie del proprietario che dicono di lanciare `check:e2e-touched` a mano
- [x] Nessun Chromium scaricato o avviato sul Mac da questo percorso (`nochrome`): lo script esce 97 su un Mac fuori da Actions prima di bundle e Playwright, l'envelope lo vieta, la riga della board non va a una shell
  - [ ] Fuori da questa tornata e ancora su Chromium: lo screenshot dell'anteprima del server (`browser-service.ts`, tornata 5) e `bun run qa:gate` senza opzioni

## Tornata 3: segnale di memoria e freno sul lavoro in volo
Disegno: `design.md` (sezione «Tornata 3»); delta in `specs/kanban` (KANBAN-15, KANBAN-84).
- [x] Il riavvio non aspetta piu' una consegna che sta solo ASPETTANDO i nostri check, e quella consegna torna da sola dopo il boot (delta in `specs/restart-gate`: RGATE-07, RGATE-08)
  - [x] `cardTurnsHoldingReload` (`lib/quiescence.ts`) + `deliveryOnlyWaitsOnChecks` in `server.ts`: corsa viva nel cancello dei check e nessun comando nel registro del governatore = non trattiene, ne' come card ne' come stream della card; un comando IN CORSO trattiene come prima; commento su `dispatchTimeoutMin` corretto (declassato a sola segnalazione dal 2026-09-04)
  - [x] `pending_deliveries` (migration `20260915230316`) + `services/pending-delivery-store.ts`: la consegna e il commit misurato sopravvivono al processo, il boot la riemette una volta sola e `sameDelivery` evita il secondo `git merge main`
  - [x] Test con orologi iniettati: scenario del 15/09 (consegna nell'attesa di memoria, sette card in coda) → «procedi», comando in corso → «rinvia», sondaggio CI → «procedi» (`lib/quiescence.test.ts`); ripresa dopo il boot senza riga rossa e con un solo riallineamento (`routes/tasks.delivery-survives-reload.test.ts`). Mutanti uccisi: consegna dimenticata dallo spegnimento, riallineamento ripetuto, turno in attesa contato fra chi trattiene
  - [x] La ripresa al boot riguarda SOLO una card ancora `in_progress` — una fermata a mano (backlog) o rimessa in coda dal reconcile (todo) viene solo dimenticata, senza lanciare la barra e senza scriverle addosso un `pass` — e il commit ricordato è quello del giro, non l'ultima misura della card, così una consegna tagliata prima del checkout riallinea al boot invece di ereditare un commit vecchio (RGATE-08). Mutanti uccisi: filtro review/done al posto di `in_progress`, stato riletto solo al caricamento e non alla riemissione, commit preso da `task.checksCommit`
- [x] `test:unit` alla consegna letto dalla CI della PR (risposta del 15/09 17:20): riga `github-ci:unit` (`UNIT_CI_CHECK`, nome `unit-ci`), verdetto = passo `Unit + integration tests` del job `check` nella run `pull_request` del commit consegnato; una spinta, una PR in bozza e un giro di sondaggi per e2e e unit (`awaitCiEvidence`); passo saltato, annullato, assente o job finito prima = non misurato
  - [x] Envelope (`UNIT_CI_KICKOFF_LINE`, fan-out, `CODE_GATES_RULE`) e `docs/board-protocol.md`: la suite unit intera si legge dalla CI, `bun test <file>` mirato resta ammesso; `board-protocol-parity` ancora la regola
  - [x] Test con risposte finte di GitHub (`ci-evidence`, `tasks.checks-ci`, `review-checks`, `task-dispatcher`, `board-protocol-parity`)
  - [ ] Rollout, SOLO dopo il merge: `PATCH /api/boards/topics-app-ar3jt5/settings` con `{ "name": "unit-ci", "cmd": "github-ci:unit" }` al posto della riga `test:unit`, e la coda di `static-rails` a `check:security --only=data,home,secrets`: tolto `test:unit` dal worktree, i due cancelli dei dati personali e dei percorsi di casa non girerebbero più prima della spinta, e sul runner non misurano niente
- [x] Pavimento riaperto solo con la memoria sopra la riga (pavimento + prezzo) per una finestra di tempo; finestra piena anche al boot; prenotazione per la vita del turno
  - [x] `server/services/mem-signal.ts`: campione asincrono (`probeVm`, `parseVmStat`) sul battito da 10 s, minimo dei 2 minuti con buchi > 30 s che svuotano la finestra, verdetto di swap (swap-in >= 10/s E debito compressore + swap usato >= +0,5 GB/min su 60 s); soglie provvisorie, senza cancello di calibrazione di 7 giorni prima del merge
  - [x] Pavimento su una riga sola (pavimento, o pavimento + prezzo con lavoro nostro in volo); prenotazione per la vita del turno contata una volta (asse budget in «per risorse», pavimento in «per numero»); l'asse budget legge il minimo della finestra; frasi «Memoria» con la lettura più bassa dei 2 minuti
  - [x] Riga `[memsig]` ogni 60 s nel log del server (non decide niente)
  - [x] Test M1-M6, C1-C2, D1-D7 (`mem-signal`, `dispatch-capacity`, `task-dispatcher-admission`, `task-dispatcher-held-resume-quiet`), mutanti: minimo della finestra sostituito dall'ultima lettura (D1, D2, D4, D5, D7, M1 rossi), prenotazione contata su tutti e due gli assi (D4, D5 rossi), prezzo mai sulla riga (D4, D6 rossi)
- [x] Attesa dei check: uno per finestra, sul minimo dei 2 minuti, mai dentro lo swap sostenuto; `e2e-touched` sotto slot non serve codice (la board legge l'e2e dalla CI dal rollout della tornata 2)
  - [x] `releaseDecision` senza prezzo per comando e senza `check-mem-prices.json`: tolto perché con la suite unit in CI nessun comando di consegna su topics-app supera 1 GB (tsc 460 MB, vite 316 MB, misurati nel disegno); fallire aperto dopo 30 minuti solo sulla memoria
  - [x] Test W1, W3, W4, W5 e «il pavimento da solo» (`review-checks-brakes`), `tasks.checks-interrupted` aggiornato
- [x] Con swap sostenuto Topics interrompe il giro di check più giovane (interrotto, riparte da solo), al massimo 1 ogni 2 min e 2 per giro
  - [x] `createSwapBrake` (albero >= 1 GB, 1 ogni 120 s, 2 per `taskId@commit`), `ChecksInterruptedError("swap")` prima di registrare il comando, rotta che tiene e riemette la consegna senza riallineare, commento di servizio sulla card, righe `[checks-swap]`
  - [x] Test S1-S5, G1, R1; mutanti uccisi: niente swap nell'attesa (W4), niente spaziatura (W3), vittima più vecchia (S1, S2), niente limite per consegna (S3), niente soglia di 1 GB (S1, S4), finestra sostituita dall'istante (W1, W5), interruzione mai lanciata (S5), motivo perso dal gate (G1), consegna non tenuta dalla rotta e riallineamento ripetuto (R1)
- [ ] Barra di esito: stalli [LAG], swap-in/s e load prima e dopo, non il conteggio delle righe di log
  - [ ] B3 si misura 72 ore dopo il land con lo script in sola lettura (scratchpad della sessione, non committato): O1 stalli [LAG]/giorno <= 0,5 x prima, O2 p95 swap-in/s e load1 non peggiori, O3 verdetti e turni/giorno >= 0,7 x prima, O4 swap sostenuto con albero >= 1 GB <= 190 s di fila
  - [ ] Rollout, SOLO dopo il merge: nessun PATCH oltre a quello di `unit-ci` qui sopra; le soglie restano provvisorie finché B3 non le conferma

## Tornata 3c: il comando più pesante di un agente sotto swap si congela, e la sessione si copre di brina
Disegno: `design.md` (sezione «Tornata 3c»); delta in `specs/kanban` (KANBAN-75, KANBAN-85). Prerequisito: PR #69, landata.
- [x] T0 in CI su macOS: forma XPC e peso di Playwright WebKit con WebGL, effetto di STOP/CONT (ramo usa e getta, run 35031447596)
  - [x] Esiti nel disegno: attribuzione per dominio + percorso, 0,44 GB per UNA pagina (sotto il pavimento, e il pavimento non si muove), fermare il solo albero non basta, un `click({timeout})` in volo scade alla ripresa
- [x] Bash in background dai `PreToolUse`, radici native registrate da `runCommand`, insieme di guardia, gruppi ammessi
- [x] `swap-freeze.ts`: candidati, il più pesante, controllo delle connessioni, freno dei check prima, spaziatura condivisa, 2 per albero
- [x] Registro `active` + `counts` scritto prima di ogni SIGSTOP; scongelamento: memoria, nessun effetto, 10 minuti, padrone sparito, spegnimento, boot
- [x] Orologi: stall detector, StaleStream, timer del bash nativo, parcheggio PTY, Stop della sessione, `LiveToolLine`
- [x] Frame `swap-freeze:state`, nota della card, storico notifiche, riga per l'agente nel suo canale
- [x] Brina: texture procedurale con zone libere sul testo, card, riga, tab, anello e banner della pane, due temi, reduced-motion
- [x] Test F1-F23 (unit e segnali veri, e2e in CI su chromium e webkit con screenshot e video)
- [ ] Barra sul server vivo (§9 del disegno), 7 giorni dopo il land: E0 candidati sopra il pavimento, E1 swap-in/s prima/dopo, E2 stalli [LAG], E3 durate e ragioni, E4 quota di «no effect»

## Tornata 4: pannelli browser pesanti
Disegno di tornata con la critica: delta in `specs/remote-browser` (BROWSER-HEAVY-01..05).
- [x] Consumo misurato per pannello nativo
  - [x] macOS: una lettura per pid per campione (`sample_cpu`, `collect_webview_usage` dal campione) e test Rust su un figlio occupato
  - [x] Windows: processi dell'ambiente WebView2 per pane, `GetProcessTimes` con la stessa regola, `browser_try_suspend`; regole del delta testate sulle tre OS
  - [x] Client: righe `webviews` da `usePerfMetrics` e lettore di ripiego per documento; attribuzione (pid condivisi, generazioni)
- [x] Sopra soglia: segnale nella tab, vivo solo col fuoco, fermo immagine con UI chiara, ritorno senza ricaricare
  - [x] Verdetto a tempo (`heavyPanes.ts`) e regola di vita (`nativePaneLive.ts`) con sosta di 2 s
  - [x] Pausa e ritorno in `useNativePanePause`: fermo prima di nascondere, ritorno che adotta il fermo come freeze, freeze rifiutato a pane in pausa, fermo a 1x
  - [x] Glifi `Gauge` / `CirclePause` dopo quelli di connessione, agente sempre primo; scheda in pausa con «Riprendi»; chiavi it/en
  - [x] Poll: eval fermi in pausa, drain con la pane a schermo o usata, download con cancello e download in corso, tutti fermi a finestra senza fuoco
  - [x] Test: banchi bun dell'hook (pausa, ritorno, overlay, freeze, op dell'agente, ricarica), download, moduli puri; spec e2e per la CI
- [x] Semantica di fuoco corretta su macOS, Windows e finestre staccate
  - [x] `window_focus.rs`: evento su principale, pop-out e finestra gruppo (tre chiamate contate da un test), `window_focus_state` (`isKeyWindow` / `GetForegroundWindow`)
  - [x] `hasFocus` per sito di montaggio; `onSelfFocus` nuovo per il gruppo del task
- [ ] Barra (P1..X del disegno), SOLO con un guscio rilasciato e la macchina calma: vedi rollout

## Tornata 5: browser remoto degli agenti su WebKit
- [ ] Card separata sulla board

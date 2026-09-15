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
  - [ ] Rollout, SOLO dopo il merge: `PATCH /api/boards/topics-app-ar3jt5/settings` con `{ "name": "e2e-ci", "cmd": "github-ci:e2e" }` al posto di `e2e-touched` e `&& bun run check:security --only=secrets` in coda a `static-rails`
  - [ ] La prima card consegnata dopo il PATCH: riga `e2e-ci` con PR e run in `checks_json`, bozza sul commit di `checks_commit`, nessun `playwright`/`chrome-headless-shell` fra i figli del server durante l'attesa
  - [ ] Il flusso di land riusa la bozza (`gh pr ready` più `gh pr edit`); le due memorie del proprietario che dicono di lanciare `check:e2e-touched` a mano
- [x] Nessun Chromium scaricato o avviato sul Mac da questo percorso (`nochrome`): lo script esce 97 su un Mac fuori da Actions prima di bundle e Playwright, l'envelope lo vieta, la riga della board non va a una shell
  - [ ] Fuori da questa tornata e ancora su Chromium: lo screenshot dell'anteprima del server (`browser-service.ts`, tornata 5) e `bun run qa:gate` senza opzioni

## Tornata 3: segnale di memoria e freno sul lavoro in volo
Disegno: `design.md` (sezione «Tornata 3»); delta in `specs/kanban` (KANBAN-15, KANBAN-84).
- [x] `test:unit` alla consegna letto dalla CI della PR (risposta del 15/09 17:20): riga `github-ci:unit` (`UNIT_CI_CHECK`, nome `unit-ci`), verdetto = passo `Unit + integration tests` del job `check` nella run `pull_request` del commit consegnato; una spinta, una PR in bozza e un giro di sondaggi per e2e e unit (`awaitCiEvidence`); passo saltato, annullato, assente o job finito prima = non misurato
  - [x] Envelope (`UNIT_CI_KICKOFF_LINE`, fan-out, `CODE_GATES_RULE`) e `docs/board-protocol.md`: la suite unit intera si legge dalla CI, `bun test <file>` mirato resta ammesso; `board-protocol-parity` ancora la regola
  - [x] Test con risposte finte di GitHub (`ci-evidence`, `tasks.checks-ci`, `review-checks`, `task-dispatcher`, `board-protocol-parity`)
  - [ ] Rollout, SOLO dopo il merge: `PATCH /api/boards/topics-app-ar3jt5/settings` con `{ "name": "unit-ci", "cmd": "github-ci:unit" }` al posto della riga `test:unit`
- [x] Pavimento riaperto solo con la memoria sopra la riga (pavimento + prezzo) per una finestra di tempo; finestra piena anche al boot; prenotazione per la vita del turno
  - [x] `server/services/mem-signal.ts`: campione asincrono (`probeVm`, `parseVmStat`) sul battito da 10 s, minimo dei 2 minuti con buchi > 30 s che svuotano la finestra, verdetto di swap (swap-in >= 10/s E debito compressore + swap usato >= +0,5 GB/min su 60 s); soglie provvisorie, senza cancello di calibrazione di 7 giorni prima del merge
  - [x] Pavimento su una riga sola (pavimento, o pavimento + prezzo con lavoro nostro in volo); prenotazione per la vita del turno contata una volta (asse budget in «per risorse», pavimento in «per numero»); l'asse budget legge il minimo della finestra; frasi «Memoria» con la lettura più bassa dei 2 minuti
  - [x] Riga `[memsig]` ogni 60 s nel log del server (non decide niente)
  - [x] Test M1-M6, C1-C2, D1-D7 (`mem-signal`, `dispatch-capacity`, `task-dispatcher-admission`, `task-dispatcher-held-resume-quiet`), mutanti: minimo della finestra sostituito dall'ultima lettura (D1, D2, D4, D5, D7, M1 rossi), prenotazione contata su tutti e due gli assi (D4, D5 rossi), prezzo mai sulla riga (D4, D6 rossi)
- [ ] Attesa dei check: rilascio con il prezzo del comando, uno per finestra, `e2e-touched` sotto slot
- [ ] Con swap sostenuto Topics interrompe il giro di check più giovane (interrotto, riparte da solo), al massimo 1 ogni 2 min e 2 per giro
- [ ] Barra di esito: stalli [LAG], swap-in/s e load prima e dopo, non il conteggio delle righe di log

## Tornata 4: pannelli browser pesanti
- [ ] Consumo misurato per pannello nativo
- [ ] Sopra soglia: segnale nella tab, vivo solo col fuoco, fermo immagine con UI chiara, ritorno senza ricaricare
- [ ] Semantica di fuoco corretta su macOS, Windows e finestre staccate

## Tornata 5: browser remoto degli agenti su WebKit
- [ ] Card separata sulla board

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
- [ ] Pavimento riaperto solo con la memoria sopra la riga (pavimento + prezzo) per una finestra di tempo; finestra piena anche al boot; prenotazione per la vita del turno
- [ ] Attesa dei check: rilascio con il prezzo del comando, uno per finestra, `e2e-touched` sotto slot
- [ ] Con swap sostenuto Topics interrompe il giro di check più giovane (interrotto, riparte da solo), al massimo 1 ogni 2 min e 2 per giro
- [ ] Barra di esito: stalli [LAG], swap-in/s e load prima e dopo, non il conteggio delle righe di log

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

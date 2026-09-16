# Design: mac-usabile-sotto-carico

Questo documento copre la **tornata 2** (scelta 1: «Solo in CI») e la **tornata 3**
(scelta 2 e le risposte del 15/09 17:20). Le altre tornate aggiungeranno le loro sezioni
qui, non una change nuova. Fino al
15/09/2026 questo disegno stava in una change a sé, `board-e2e-on-pr-ci`, approvata
con «Sì, sulla CI (Recommended)»: è confluita qui perché risponde alla stessa scelta.

## Tornata 2: gli e2e degli agenti solo in CI

### Perché

Il sesto check della board `topics-app-ar3jt5` è `bun run check:e2e-touched`: sceglie
le spec legate al diff e le esegue con Playwright, cioè con Chromium, nel worktree
dell'agente. La notte del 15/09/2026 gli agenti hanno scaricato `chromium-1217` in
`~/Library/Caches/ms-playwright` per farlo girare, e la regola della postazione è
«niente Chrome né Chromium sul Mac» (la barra `nochrome` esce 1).

La stessa misura esiste già dove un browser è di casa. Il workflow `CI`, su ogni
`pull_request`, fa girare il tier PR della suite in quattro shard e, nello shard 1,
proprio `check:e2e-touched --base=FETCH_HEAD`. Misurato: 14 minuti di mediana
a GitHub tranquillo, 42 durante una raffica di dieci PR, 28.100 minuti a settembre
e 0 dollari (il repo è pubblico). Il land del proprietario passa già da ramo, PR,
CI e merge.

Il pezzo che manca è il ponte. Un push da solo non fa partire niente: `ci.yml`
ascolta `push` solo su `main`, e su 300 run nessuna era un push di un ramo. Gli
agenti non possono pushare (l'envelope lo vieta), e il server non apre PR. Il
runner dei check, poi, non sa aspettare 15-45 minuti: il tetto di un comando è
20 minuti, un giro tiene una delle due corsie, e il turno in attesa prenota
memoria nell'ammissione.

### Cosa cambia

- **Un check di evidenza, non un comando.** La board dichiara `github-ci:e2e`
  (`E2E_CI_CHECK` in `shared/board.ts`) al posto di `bun run check:e2e-touched`.
  Il runner non lo passa a una shell: finiti verdi i comandi locali, il server
  restituisce la corsia, spinge sul ramo il commit che ha misurato, apre o riusa
  una PR in bozza e legge i job `prepare-e2e` ed `e2e (N)` della run
  `pull_request` di QUEL commit (`server/services/ci-evidence.ts`).
- **Tre esiti, come KANBAN-15.** Verde solo con tutti i job e2e `success`. Rosso con
  un job e2e `failure`, e il referto nomina i job e il comando del log. «Non
  misurato» (uscita 97) per tutto il resto: nessuna run, run annullata o superata,
  un commit diverso, `gh` assente o non autenticato, conflitto con main, API giù,
  nessun verdetto in 60 minuti.
- **L'attesa è nostra e costa zero.** La corsa resta viva (202, giudice del
  silenzio e spazzino dei tool la vedono come attesa nostra) ma non tiene una
  corsia, non conta fra le corse del dispatcher e il turno non prenota memoria.
  Il client di `update_task` aspetta fino a 100 minuti invece di 50.
- **Niente browser sul Mac per questo check.** Senza `--list`, fuori da GitHub
  Actions e su un Mac, `check:e2e-touched` esce 97 prima di costruire o lanciare
  qualunque cosa. `--list` resta com'è, ed è ciò che l'envelope indica.
- **I testi dicono la regola.** `buildKickoff` e il kickoff di fan-out tolgono il
  check dall'elenco dei comandi da lanciare e dicono che l'e2e gira sulla CI dopo la
  spinta del server, che il ramo diventa pubblico in quel momento, che qui non si
  lancia né si installa un browser. `docs/board-protocol.md`, `tests/e2e/README.md`
  e l'intestazione di `scripts/qa-gate.sh` si allineano.


## Contesto misurato (15/09/2026)

- Riga viva `board_settings.review_checks` di `topics-app-ar3jt5`: `typecheck`, `lint`,
  `check:deadcode`, `static-rails` (10 comandi incatenati), `test:unit`
  (`test:unit:shards`), `e2e-touched` (`bun run check:e2e-touched`). Nessun codice
  aggiunge `e2e-touched`: è solo quella riga.
- Nel DB vivo `e2e-touched` ha girato 122 volte: 120 verdi (media 50 s, max 402 s,
  47 a zero secondi) e 2 rosse. Dei 129 task con quel check, 10 avevano
  `delivery_files_changed = 0`.
- Il giro LOCALE senza e2e (61 card dal 08/09): minimo 3,5 min, media 10,6, massimo
  29,2 (solo tempo dei comandi, senza coda di corsia né attesa di memoria).
- CI della PR: run 34931860236 (quieta) 14 min, job `e2e (N)` partiti 1 min dopo la
  creazione; raffica del 15/09 03:33, dieci PR in 16 s: fino a 42 min.
- Nomi dei job letti via API: `check`, `prepare-e2e`, `e2e (1)`..`e2e (4)`, `tauri (…)`.
  Una run annullata prima dell'espansione della matrice ha un job `e2e` senza numero.
- Quando «Run E2E tests» dello shard 1 fallisce, il passo «E2E dei file toccati» è
  `skipped` (verificato su tre run rosse): lo `if` non contiene una funzione di stato,
  quindi vale `success() &&`.
- Rossi e2e: 9 run PR su 60 recenti avevano un job `e2e (N)` rosso; 6 run di main su 40.
- `main` non è protetto, nessun check è obbligatorio. `secret_scanning_push_protection`
  del repo è `disabled` (API `repos/armonia/topics-app`).
- Origin: `git@github.com:armonia/topics-app.git` (SSH); `core.logAllRefUpdates=true`,
  reflog dei rami `topics/*` presenti. `gh` autenticato col keyring (scope `repo`,
  `workflow`).
- Ultimi 7 giorni su `main`: 31 land locali (`merge task …`) e 6 `Merge pull request`.
  Remote: 29 teste `topics/*`, 30 PR storiche da rami `topics/*`.
- Card con check dal 06/09: 150, di cui 122 atterrate; circa il 13% non atterra mai.

## Decisioni

### D1. La riga della board è un check di EVIDENZA, scritto come comando

`E2E_CI_CHECK = { name: "e2e-ci", cmd: "github-ci:e2e" }` in `shared/board.ts`, con
`isCiEvidenceCheck(check) = check.cmd.trim() === E2E_CI_CHECK.cmd`.

Perché nella stringa del comando e non in un campo nuovo di `ReviewCheck`: il campo
delle impostazioni (`ReviewChecksField`, `BoardSettingsPanel.tsx:333-375`) salva
«un comando per riga» ricostruendo `{ name: cmd, cmd }`, quindi un campo in più
sparirebbe al primo salvataggio da UI. La riga sopravvive al giro.

Perché `shared/board.ts`: la leggono dispatcher, rotta e formatter; nessun ciclo
(GATE-08). Costa ~10 righe su 29 di margine di `check:bloat`.

### D2. La misura vive nel processo del server, non in un comando

Un comando che aspetta la rete terrebbe un processo Bun vivo per 15-45 minuti,
passerebbe dal freno di memoria, conterebbe come albero del governatore e morirebbe
al tetto di 20 minuti. La fase CI è una funzione del server
(`awaitE2eEvidence`) che fa brevi `git`/`gh` e dorme fra un sondaggio e l'altro.
Anche quei `git`/`gh` sono lavoro di un check di consegna, quindi nascono a priorità
bassa come i comandi (KANBAN-78).

### D3. Prima i comandi locali, poi la spinta

La spinta avviene SOLO dopo che tutti i comandi locali sono verdi. Il motivo non è il
tempo (in parallelo si risparmierebbero ~10 minuti) ma la pubblicazione: il repo è
pubblico, e due cancelli decidono se un checkout si può pubblicare
(`no-personal-data-tracked`, `no-home-paths-tracked`). Un commit che li viola non deve
arrivare su GitHub, e sul runner non misurano niente: la home si ricava dalla macchina
(là è `runner`) e `.personal-terms` non è tracciato. Stavano dentro `test:unit`, che dalla
tornata 3 si legge dalla CI (D15); quindi al rollout la coda di `static-rails` diventa
`bun run check:security --only=data,home,secrets` (vedi Rollout): due `bun test` e la
ricerca dei segreti, ~6 s, locali e prima della spinta. I segreti ci sono perché la
protezione dei push di GitHub è spenta.

Il check CI si misura sempre DOPO i comandi, qualunque sia la sua posizione
nell'elenco dichiarato.

### D4. La corsia si restituisce

`checks-gate.ts`: `run` riceve `lane: ChecksLane` con `release()`. Dopo `release()` la
corsa resta nel registro (`isRunning` vero, le gambe rispondono 202, `settleDelivery`
aspetta), NON conta in `runningCount()` (quindi nemmeno nel `gateRuns` del dispatcher)
e sblocca la prima corsa in coda. `release()` è idempotente e il `finally` la chiama
comunque. `isOffLane(key)` dice «viva e senza corsia».

### D5. Chi spinge, cosa, e quando si forza

Il server, con `GIT_TERMINAL_PROMPT=0`:

1. `git rev-list --count main..<sha>` nel worktree. `0` ⇒ nessun commit proprio:
   nessuna spinta, nessuna PR, check VERDE con la nota «nessun commit proprio oltre
   main». È il comportamento di oggi («nothing changed against main»), e bloccarlo
   fermerebbe le consegne senza file (10 su 129).
2. `git push --porcelain origin <sha>:refs/heads/<ramo>`: il commit ESATTO, non `HEAD`.
3. Rifiuto non fast-forward (`[rejected] (non-fast-forward)` o `(fetch first)`):
   `git ls-remote origin refs/heads/<ramo>` dà la testa remota. Se compare in
   `git reflog show --format=%H refs/heads/<ramo>` (il ramo l'ha già avuta: tipicamente
   un `git rebase main` dopo un conflitto di land) si rispinge con
   `--force-with-lease=refs/heads/<ramo>:<testa remota>`. Altrimenti qualcuno ha
   scritto sul ramo commit che questo worktree non ha mai avuto: «non misurato», e il
   ramo remoto non si tocca.

Il repo si ricava da `git remote get-url origin` (`owner/name`, SSH o HTTPS); un
origin che non è GitHub è «non misurato».

### D6. La PR

`gh pr list --repo <repo> --head <ramo> --state open --json number,url --limit 1`; se non
c'è, `gh pr create --repo <repo> --draft --base main --head <ramo>`. Titolo
`board: <ramo> (card <id8>)`, corpo in inglese con commit e card corti e la frase «not a
request to merge: a person marks it ready when the card lands». Nessun testo della card
va su GitHub. Le bozze fanno partire `pull_request` (nessun filtro `draft` in
`ci.yml`, verificato). Un land locale `merge --no-ff` seguito dal push di main rende la
testa della PR raggiungibile da main, e GitHub la segna fusa da sé.

### D7. Come si legge GitHub

Chiamate: `gh api "repos/<repo>/actions/runs?head_sha=<sha>&event=pull_request&per_page=20"`,
poi `gh api "repos/<repo>/actions/runs/<id>/jobs?filter=latest&per_page=100"`.

`readE2eEvidence(sha, runs, jobs)` è pura:

| Stato letto | Esito |
|---|---|
| nessuna run con `head_sha === sha`, `event === "pull_request"`, `path === ".github/workflows/ci.yml"` | in attesa |
| la run con `id` più alto è `completed/cancelled` | non misurato (annullata o superata) |
| `prepare-e2e` concluso e non `success` | non misurato (gli shard non sono partiti) |
| un job `/^e2e( \(\d+\))?$/` non ancora `completed` | in attesa |
| tutti conclusi, almeno uno `failure` | ROSSO: nomi dei job + `gh run view --job <id> --log-failed -R <repo>` |
| tutti conclusi `success`, almeno uno | VERDE |
| tutti conclusi, nessun `failure`, qualcuno `cancelled`/`skipped`/`timed_out`/`neutral`/`action_required` | non misurato |
| run conclusa senza nessun job e2e | non misurato |

Solo i job e2e contano: `check` e `tauri` rossi non cambiano questo esito (i comandi
locali coprono il primo, il secondo non è un check della board).

### D8. Cosa gira esattamente

La run `pull_request` fa il checkout di `refs/pull/<N>/merge`: il commit consegnato
fuso sulla punta di `main` di GitHub nel momento dell'evento (una mossa successiva di
main non la rilancia). Il check-run resta attaccato al commit consegnato. Poiché il
server ha appena riallineato il ramo su main, la differenza sono solo i commit arrivati
su main nel frattempo, cioè quelli che atterrerebbero con lui.

- `prepare-e2e`: piano di sharding per durata con `E2E_TIER=pr`.
- `e2e (1..4)`: build del client, `playwright test` con `E2E_TIER=pr`, cioè
  `testIgnore: NIGHTLY_ONLY_SPECS`, `grepInvert: /@nightly/`, `retries: 2`, progetti
  `chromium` più `webkit` per `drag-preview`, su Linux.
- Solo nello shard 1 e solo se il passo precedente è verde: `check:e2e-touched
  --base=FETCH_HEAD`, fino a 8 spec toccate SENZA il filtro di tier.

È più di quanto misurava il check locale (solo le spec toccate): è la barra su cui la
PR del land viene già fusa.

### D9. Tempi

| Costante | Valore | Da dove viene |
|---|---|---|
| `CI_E2E_DEADLINE_MS` | 60 min dalla spinta | 42 min misurati nella raffica, più margine |
| `CI_POLL_MS` | 60 s | una run dura almeno 14 min; 2 chiamate/min per card sul token da 5.000/h |
| `CI_NO_RUN_GRACE_MS` | 5 min | una run nasce in secondi; dopo, si chiede `mergeable` una volta: `CONFLICTING` ⇒ non misurato |
| `CI_API_ERRORS_MAX` | 5 di fila | un errore isolato non decide; cinque minuti di API giù sì |
| timeout di una chiamata `git`/`gh` | 60 s | un comando appeso è un errore, non un'attesa |
| `CHECKS_MAX_LEGS` | 240 (100 min) | SOPRA 60 min di CI + 29,2 min del giro locale più lento misurato; SOTTO il `MCP_TOOL_TIMEOUT` che `buildSafeEnv` dà alla CLI (`ASK_TTL_MS` + 5 min = 24 h 5 min, `server/providers/claude-code.ts:284`), così che all'agente arrivi il messaggio del ponte «si completa da sola» e non un errore di trasporto |

Il primo sondaggio è immediato: dopo un riavvio la run dello stesso commit può essere
già conclusa, e la si legge senza aspettare e senza rispingere.

### D10. Gli orologi della board, uno per uno

| Orologio | Cosa fa alla fase CI |
|---|---|
| tetto di `runOne` (20 min, ×3 col rallentamento) | niente: la fase CI non è un comando; ha la sua scadenza |
| corsie (`checksLanes`) | restituita prima di aspettare (D4) |
| `gateRuns` del dispatcher (`checksRunning`) | la corsa senza corsia non conta |
| prenotazione di memoria dell'ammissione (`reservedCost(localLaunches())`) | `localLaunches()` salta i task con `checksOffLane(taskId)` vero |
| freno di memoria (30 min prima di un comando) | non si applica: nessun processo parte |
| governatore del budget (congela alberi) | nessun pid registrato, nessun congelamento |
| client MCP (gambe da 25 s) | 240 gambe, sotto il `MCP_TOOL_TIMEOUT` della CLI; oltre, `pendingDeliveries` atterra comunque il verdetto |
| giudice del silenzio (5 min) | `isChecksHold`: `checksGate.isRunning` resta vero, riarma |
| spazzino stale-stream (tool a 30 min) | `waitingOnOurChecks` resta vero, proroga |
| `dispatchTimeoutMin` | solo log |
| spegnimento (`stopReviewChecks`) | il sonno controlla `reviewChecksStopping()` ogni secondo e lancia `ChecksInterruptedError`: 202, nessun verdetto; una chiamata `gh`/`git` già partita finisce da sola entro il suo tetto di 60 s, e la gamba intanto risponde 202 come ogni gamba in volo |
| riavvio | il giro nuovo rifà i comandi locali (come oggi) e ritrova la stessa run per SHA; se il riallineamento cambia il commit, run nuova e la vecchia viene annullata dalla concorrenza |
| `restart-when-idle` (25 min) | il turno in attesa conta in `busyCount`: aspetta o taglia come per ogni turno |
| ritenzione del verdetto (5 min, per commit) | invariata |

### D11. Il Mac non lancia browser per questo check

`scripts/check-e2e-touched.ts`: `refusesToRunSpecs({ platform, githubActions, listOnly })`
è vero per `platform === "darwin" && !githubActions && !listOnly`. In `main()`, subito
dopo la selezione e la stampa dell'elenco (quindi `--list` resta identico), stampa
«specs run in the PR CI (`e2e (1)`), never on this Mac: use --list» ed esce 97, prima
di `pickNodeBin`, del bundle e di Playwright. Linux e Windows restano come sono (il PC
è la macchina delle batterie), e GitHub Actions esporta `GITHUB_ACTIONS=true`.

### D12. Cosa diventa pubblico

Già pubblico oggi: `main`; le 29 teste `topics/*` e le 30 PR storiche dei rami che il
proprietario ha scelto di atterrare via PR, con titoli, corpi e log delle run.

Nuovo: ogni commit consegnato di ogni card della board, nel momento della consegna e
prima di qualunque review, comprese le consegne poi rifiutate o rifatte (circa il 13%
delle card non atterra: le loro bozze restano aperte); i messaggi di commit; il nome del
ramo; una PR in bozza con l'id corto della card; i log della CI. Se `main` locale ha land
non ancora pushati, il ramo riallineato li porta con sé: sono commit già accettati da una
persona, che il prossimo push di main pubblica comunque.

Non esce: testo, thread, trascritti e allegati della card, il DB.

### D13. Testi per l'agente e per le persone

- `buildKickoff`: la riga `PRE-REVIEW CHECKS` elenca solo i comandi locali; se la board
  dichiara `E2E_CI_CHECK` si aggiunge UNA riga:
  «- E2E RUNS ON GITHUB CI, NEVER HERE: once the gates above are green the board (not
  you) pushes the commit it measured to your branch, opens or reuses a draft pull
  request and waits for the e2e jobs of that exact commit (15-45 min; `update_task`
  stays open, do not call it again). The repo is public: your commits become public at
  that moment. Never run Playwright or a browser here and never install one (no
  Chromium on this machine); `bun run check:e2e-touched --list` shows which specs your
  diff touches. A red job comes back with its name and `gh run view --job <id>
  --log-failed`; no verdict for that commit (cancelled, superseded, timed out, GitHub
  unreachable) is NOT MEASURED: not your red, and the card still stays out of review.»
- `buildFanoutKickoff`: «run these commands» senza il check CI; se dichiarato,
  «- E2E runs on GitHub CI for the attempt that is chosen, never here: do not run
  Playwright or any browser, and never install one.»
- **Anche senza la riga (decisione del 15/09/2026, «Solo in CI»).** In 15 ore gli
  agenti avevano lanciato da sé 21 `check:e2e-touched`, 71 `playwright test` e 27 build
  del client, 99 su 119 in background con `&`: lavoro che la riga della board non
  tocca, perché parte durante il turno. Per questo `CODE_GATES_RULE` porta una regola
  che vale per ogni board: su questa macchina niente `check:e2e-touched` (tranne
  `--list`), niente `playwright test`, niente build del client fatte per gli e2e, niente
  browser installati o lanciati; l'agente scrive o cambia la spec e la prova arriva
  dalla CI del ramo. `bun test <file>` mirato resta ammesso. Il ramo video di
  `PREVIEW_RULE` non manda più a registrare una clip Playwright qui: la clip si
  registra dal pannello browser del task (`screencapture -V`), o viene dalla CI.
- `docs/board-protocol.md` righe 58-67: il paragrafo «Le e2e dei file toccati sono il
  sesto check» diventa «L'e2e di una consegna la misura la CI della PR, non questo Mac
  (dal 15/09/2026)», con la stessa regola in italiano.

### D14. Il formatter

`formatChecksComment` e `formatChecksThreadSummary`: per un run CI non misurato il
testo dice «non ha un esito della CI per questo commit» e rimanda al motivo nel referto,
senza il consiglio `cd client && bun install`; per un rosso CI il motivo è «e2e rossi
sulla CI della PR» invece di `exit 1`. Il resto è invariato.

## File per file

| File | Modifica |
|---|---|
| `shared/board.ts` | `E2E_CI_CHECK`, `isCiEvidenceCheck` subito dopo `interface ReviewCheck` (:1568) |
| `server/services/checks-gate.ts` | tipo `ChecksLane`; `leg({ run: (lane) => … })`; in `start.execute` un `release()` idempotente che decrementa `activeCount`, segna `offLane` e chiama `drain()`, richiamato nel `finally`; `isOffLane(key)` in `ChecksGate` |
| `server/services/ci-evidence.ts` (nuovo) | tipi `GithubRun`/`GithubJob`; costanti di D9 e `CI_WORKFLOW_PATH`, `CI_BASE_BRANCH`; `repoFromRemote(url)`; `pushRejectedAsNonFastForward(out)`; `readE2eEvidence` (D7); `ciCheckRun(check, outcome, ms)` e `ciNotMeasured(check, reason)` che producono `CheckRun` (verde `code 0`; rosso `code 1` con coda: PR, run, job rossi e comandi del log; non misurato `code 97`, `notMeasured: true`, motivo in testa alla coda; mai `timedOut`); porta `GithubPort` e `githubPort()` con spawn ad argv (mai una stringa di shell: ramo e titolo vengono dal repo) a 60 s, a priorità bassa (`lowPriorityArgv`, KANBAN-78: è lavoro di un check di consegna), che non lanciano mai; `awaitE2eEvidence({ cwd, sha, taskId }, deps)` (D5, D6, D9, D10) |
| `server/services/review-checks.ts` | i due rami di D14 (~10 righe: il file è a 777, la soglia di `check:bloat` per un file non censito è 800) |
| `server/routes/tasks.ts` | `TasksRouterOpts.ciE2eEvidence?: (input: { cwd: string; sha: string; taskId: string }) => Promise<CheckRun>`; in `runChecksGate` (:1068-1194): `localChecks`/`ciCheck`, `runReviewChecks(localChecks, …)` con `progress.total = checks.length`, poi se `ciCheck` e tutti verdi: `lane.release()`, `runs.push(await opts.ciE2eEvidence(...))` oppure `ciNotMeasured(ciCheck, "no CI evidence reader on this server" / "the worktree has no commit")`, `throwIfStopping()`; il verdetto resta `checksVerdict(runs, checks.length)` |
| `server.ts` | `ciE2eEvidence: (input) => awaitE2eEvidence(input)` nelle opzioni della rotta (:2401-2482); `checksGateIsOffLane` accanto a `checksGateIsRunning` (:1414-1416) e in `onChecksGate` (:2476); dep del dispatcher `checksOffLane: (id) => checksGateIsOffLane?.(id) ?? false` accanto a `checksRunning` (:1587) |
| `server/services/task-dispatcher.ts` | `DispatcherDeps.checksOffLane?`; `localLaunches()` (:1031) salta quei task; `buildKickoff` (:2218, :2309-2313) e `buildFanoutKickoff` (:2773, :2795-2799) come in D13 (~15 righe; margine di `check:bloat` 57) |
| `server/mcp/topics-mcp-server.ts` | `CHECKS_MAX_LEGS = 240` (:1961) e il commento sopra con i due confini di D9 |
| `scripts/check-e2e-touched.ts` | intestazione (:1-57): la board non lo esegue più, lo esegue la CI in `e2e (1)`, sul Mac si usa `--list`; `refusesToRunSpecs` e l'uscita 97 di D11 in `main()` fra :380 e :382 |
| `docs/board-protocol.md` | paragrafo :58-67 (D13) |
| `tests/e2e/README.md` | «Before landing» (:73-88): `--list` in locale, esecuzione nella CI della PR; una riga sotto «Running»: sul Mac del proprietario nessun Chromium, la suite gira in CI o sul PC |
| `scripts/qa-gate.sh` | intestazione :32-37: `check:e2e-touched` lo misura la CI della PR e la board ne legge il verdetto; qui solo `--list` (il nome resta: lo cerca `qa-gate-covers-ci.test.ts`) |
| `server/services/dispatch-capacity.ts` | commento :276-281 e frase :592 «(shard unit, e2e)» → «(shard unit)», stessa riga |
| `server/lib/stale-stream-verdict.ts` :120-123, `server/routes/tasks.ts` :948 e :992 | commenti: 50 → 100 minuti |
| `.github/workflows/ci.yml` :842-843 | commento: l'uscita 2 fa fallire il passo, non è «NOT MEASURED»; la board legge questo job |
| `openspec/changes/pane-zoom/design.md` :798, `tasks.md` :823 | «`check:e2e-touched` prima di consegnare» → la CI della PR, `--list` in locale |

## Test, e il mutante che ciascuno uccide

Tutti `bun:test`, lanciati uno per file con `TOPICS_GATE_SLOTS=0 bun test <file>`.
Finché KANBAN-84 non è in `openspec/specs/`, i file nuovi dichiarano `@covers KANBAN-15`
(e GATE-11 per lo script): un id che le spec non hanno fa uscire 1
`check:spec-coverage` dentro `static-rails` e la consegna tornerebbe indietro.

`server/services/ci-evidence.test.ts` (nuovo)
1. run verde per un ALTRO sha e nessuna per il nostro ⇒ in attesa. Mutante: niente filtro su `head_sha`.
2. run `push` verde sul nostro sha ⇒ in attesa. Mutante: niente filtro su `event`.
3. due run del nostro sha, la vecchia verde e la nuova annullata ⇒ non misurato. Mutante: prendere la prima verde o la più vecchia.
4. `e2e (2)` `failure`, gli altri verdi ⇒ rosso; la coda nomina `e2e (2)` e `gh run view --job <id> --log-failed`. Mutante: `failure` letto come non misurato, o coda senza comando.
5. tre `success` e uno `in_progress` ⇒ in attesa. Mutante: `some` al posto di `every`.
6. `prepare-e2e` `failure` ed e2e `skipped` ⇒ non misurato che nomina `prepare-e2e`. Mutante: «nessun failure» = verde.
7. run conclusa senza job e2e ⇒ non misurato. Mutante: `every` su lista vuota.
8. `e2e (3)` `timed_out` o `cancelled`, gli altri verdi ⇒ non misurato. Mutante: verde o rosso.
9. job `e2e` senza numero `cancelled` ⇒ non misurato. Mutante: regex senza il numero opzionale.
10. awaiter, `draftPullRequest` risponde errore di autenticazione ⇒ `code 97` subito e `runs` mai chiamato. Mutante: continuare a sondare.
11. push rifiutato non fast-forward con testa remota fuori dal reflog ⇒ non misurato, spinta forzata mai chiamata. Mutante: forzare sempre.
12. stesso rifiuto con testa remota nel reflog ⇒ spinta con `lease` uguale a quella testa, poi sondaggio. Mutante: lease assente.
13. run sempre `in_progress` con orologio finto ⇒ non misurato a 60 min, mai verde. Mutante: nessuna scadenza (il test scade) o scadenza che torna verde.
14. nessuna run per 5 min e `mergeable = CONFLICTING` ⇒ non misurato «conflicts» prima della scadenza. Mutante: niente sonda del conflitto.
15. tre errori API poi verde ⇒ verde; cinque di fila ⇒ non misurato. Mutante: budget di errori 0 o infinito.
16. `stopping` che diventa vero durante il sonno ⇒ rigetta `ChecksInterruptedError`. Mutante: ignorare lo spegnimento.
17. zero commit propri oltre main ⇒ verde con la nota, spinta e PR mai chiamate. Mutante: non misurato, o spinta comunque.
18. la spinta porta `<sha>:refs/heads/<ramo>`. Mutante: spingere `HEAD`.
19. contratto con `.github/workflows/ci.yml` letto da disco: esistono i job `prepare-e2e` ed `e2e` con `needs: prepare-e2e`, `E2E_TIER: pr` e il passo dei file toccati sotto `github.event_name == 'pull_request'`. Mutante: rinominare un job in `ci.yml`.
20. contratto dei tempi: `CI_E2E_DEADLINE_MS + 30 * 60_000 <= CHECKS_MAX_LEGS * CHECKS_LEG_MS < ASK_TTL_MS + 5 * 60_000` (il `MCP_TOOL_TIMEOUT` di `buildSafeEnv`). Mutanti: lasciare 120 gambe; abbassare `ASK_TTL_MS` sotto le gambe (la CLI taglierebbe il tool prima del ponte).

`server/services/checks-gate.test.ts`
21. `release()` ⇒ `runningCount()` 0, `isRunning` e `isOffLane` veri. Mutante: niente decremento.
22. `maxConcurrent: 1`: A restituisce la corsia ⇒ B in coda parte PRIMA che A finisca. Mutante: niente `drain()`.
23. doppio `release()` più la fine naturale con B in corsia ⇒ `runningCount()` 1 e C in coda non parte. Mutante: rilascio non idempotente.

`server/routes/tasks.checks-ci.test.ts` (nuovo; `tasks.test.ts` è oltre la soglia di dimensione)
24. check `["true", "github-ci:e2e"]` da PATCH e lettore finto verde ⇒ 200, review, `checksState: pass`, due run. Mutante: passare la riga CI a `runReviewChecks` (`sh` esce 127, 409).
25. comando locale rosso ⇒ il lettore CI non viene chiamato. Mutante: chiamarlo comunque.
26. lettore finto non misurato ⇒ 409 `review_needs_green_checks`, `checksState: unknown`, card in lavorazione, l'errore porta il motivo e non «bun install». Mutante: testo generico.
27. lettore finto rosso ⇒ 409, `checksState: fail`, l'errore contiene `e2e (2)` e `--log-failed`.
28. nessun lettore iniettato con il check dichiarato ⇒ `unknown`, mai `pass`. Mutante: saltare il check senza lettore.
29. lettore finto in sospeso: gate catturato con `onChecksGate` ⇒ `runningCount()` 0, `isRunning` vero, `checksProgress` `{ done: 1, total: 2 }`. Mutanti: niente `lane.release()`; totale letto dall'elenco locale.
30. lettore finto che lancia `ChecksInterruptedError` ⇒ 202 `review_checks_running`, card in lavorazione, né `pass` né `fail`. Mutante: errore trasformato in non misurato (409).

`server/services/review-checks.test.ts`
31. `formatChecksComment` e `formatChecksThreadSummary` su un run CI non misurato ⇒ «NON MISURATI», il motivo della coda, niente «bun install» e niente «non e' partito». Mutante: ramo generico.

`server/services/task-dispatcher-admission.test.ts`
32. modo `resources`, `budgetShare 0.5`, `agentMemSamples: () => [4]`, campione `{ ...QUIET, availableMemGB: 14, running: 2 }` (con `running: 0` scatterebbe l'esenzione del primo agente e il test non misurerebbe niente): partono due card (orologio avanzato oltre `ADMISSION_SPACING_MS` fra le due e poi oltre la finestra di riscaldamento, così resta solo la prenotazione di memoria, 2 x 4 GB, che porta la quota libera a 3 GB, sotto il prezzo); con `checksOffLane` vero per entrambe la terza parte, con il predicato falso resta ferma e il blocco nomina la memoria. Mutante: niente filtro in `localLaunches()`.

`server/services/task-dispatcher.test.ts`
33. kickoff con `[typecheck, E2E_CI_CHECK]` ⇒ la riga `PRE-REVIEW CHECKS` nomina `bun run typecheck` e non `github-ci:e2e`, c'è «E2E RUNS ON GITHUB CI, NEVER HERE», nessuna riga italiana; senza il check CI la riga non c'è. Mutante: testo di prima, o riga sempre presente.
34. kickoff di fan-out con il check CI ⇒ «run these commands» senza `github-ci:e2e`, c'è la riga «never here». Mutante: elenco non filtrato.

`server/services/board-protocol-parity.test.ts`
35. il documento contiene `github-ci:e2e` e l'envelope la riga «E2E RUNS ON GITHUB CI, NEVER HERE». Mutante: toglierla da uno dei due.

`scripts/check-e2e-touched.test.ts`
36. `refusesToRunSpecs`: vero solo per darwin, fuori da Actions, senza `--list`.
37. lo SCRIPT VERO in un repo temporaneo (ramo che modifica `tests/e2e/a.spec.ts`, nessun `node_modules`): `--list` esce 0 e stampa la spec ovunque; senza `--list` e con `GITHUB_ACTIONS` vuoto esce 97 su darwin, e diverso da 97 altrove (lì Playwright manca nel repo temporaneo: `ENOENT`, uscita 1, nessun browser). Mutanti: guardia tolta (uscita 1 su darwin); guardia che ignora `--list` (97 anche con `--list`).

## Rollout, in quest'ordine

1. Probe delle credenziali dall'ambiente del server (primo task).
2. Codice e test su un ramo, PR, CI verde, merge.
3. Il watcher ricarica il server; le sessioni nuove prendono le 240 gambe.
4. SOLO ADESSO: `PATCH /api/boards/topics-app-ar3jt5/settings` con `reviewChecks` =
   le cinque righe attuali, con `&& bun run check:security --only=data,home,secrets` in coda a
   `static-rails`, e `{ "name": "e2e-ci", "cmd": "github-ci:e2e" }` al posto di
   `e2e-touched`. Al contrario, il runner vecchio passerebbe `github-ci:e2e` a `sh`:
   uscita 127, rosso su ogni consegna.
5. Una card vera: `checks_json` ha la riga `e2e-ci` con PR e run, la PR esiste in bozza,
   e durante la sua attesa `ps` non mostra `playwright` né `chrome-headless-shell` fra i
   figli del server.
6. Archivio della change e `@covers KANBAN-84` sui file nuovi nello stesso commit.

## Rischi

- **Pubblico prima della review.** Vedi D12. La protezione dei push di GitHub è spenta;
  prima della spinta gira, dal rollout, `check:security --only=data,home,secrets` in coda
  a `static-rails` (dati personali, percorsi di casa, segreti): dopo la tornata 3
  `test:unit` non gira più nel worktree, e l'hook pre-push cerca solo `.personal-terms`.
- **Attesa.** Giro locale (media 10,6 min, max 29,2) più CI (14-42 min). Nel modo a conteggio
  del tetto la card in attesa tiene il suo posto (è `in_progress`): meno card in parallelo.
  Oltre le 240 gambe il turno si chiude e il dispatcher riprende l'agente consumando un
  tentativo, come già oggi oltre i 50 minuti.
- **Il tier PR intero ferma la consegna.** Un rosso non legato al diff (flaky, o già rosso su
  main: 6 run di main su 40) torna all'agente. Il verdetto è per commit: per rimisurare
  serve un commit nuovo; nessun rilancio automatico.
- **Riavvii.** Ogni reload del server durante l'attesa rifà i comandi locali; se main si è
  mosso, il riallineamento cambia il commit e la CI riparte da zero.
- **Dipendenza da GitHub.** API giù, `gh` scaduto o SSH rotto rendono ogni consegna non
  misurata: 409 con il motivo, card ferme finché non si ripara.
- **Bozze orfane.** Le card che non atterrano lasciano PR in bozza e rami: nessuna pulizia in
  questa change. Il flusso di land del proprietario deve riusare la bozza (`gh pr ready` più
  `gh pr edit`) invece di `gh pr create`, che fallirebbe con «already exists». Ogni bozza è
  anche una notifica GitHub.
- **Coda di GitHub.** Circa una run da 9 job in più per consegna, in concorrenza con le PR del
  proprietario e i push di main: la raffica misurata è arrivata a 42 minuti.
- **Accoppiamento con `ci.yml`.** Nomi dei job e percorso del workflow sono letti a mano: il
  test 19 li tiene allineati.
- **`nochrome` resta rossa per altre strade**, fuori da questa tornata: lo screenshot
  dell'anteprima del server di produzione (`browser-service.ts`, Chromium headless su ogni
  card che entra in review, tornata 5), e `bun run qa:gate` senza opzioni, che lancia la
  E2E intera. Il ramo video di `PREVIEW_RULE` («Playwright clip») è chiuso qui. Cancellare la cache di Chromium spegne lo screenshot dell'anteprima.
- **Cancelli del ramo che implementa.** `check:bloat` (margini: dispatcher 57 righe,
  `shared/board.ts` 29, `review-checks.ts` 23 alla soglia degli 800), `check:identifier-language`
  (niente nomi con `mergeable`: non è nel dizionario), `check:spec-coverage` (vedi sopra).
- **Memorie del proprietario** che dicono di lanciare `check:e2e-touched` a mano
  (`feedback_push-su-main-solo-dopo-test-unit-shards.md`,
  `project_ci-rossa-una-settimana-e2e-touched-sesto-check.md`): da aggiornare dopo il land.

## Tornata 3: segnale di memoria onesto e freno sul lavoro in volo

Disegno rivisto il 15/09 dopo una critica avversaria (quattro bloccanti, tutti chiusi), poi
ristretto dal lead dopo la risposta del proprietario delle 17:20 «test:unit alla consegna:
dalla CI della PR». Qui le decisioni e i numeri su cui stanno; i test sono nei file.

### Misure (15/09/2026)

- Tre riaperture del pavimento su una lettura sola (10:37 14,5 GB con 12 GB di swap; 11:03
  5,5 / 10,4 / 5,5), richiuse entro 19-115 s. Il picco delle 10:37 è durato al massimo ~124 s:
  2 minuti è la finestra più corta che il log dimostra sufficiente.
- Senza lavoro di Topics questo Mac legge 11,70 GB da riposato e 6,1 GB alle 14:50: ogni riga
  «pavimento + X» con X > 5,7 GB è irraggiungibile anche a board vuota.
- Il livello di pressione del kernel è un rapporto del compressore (entra a ~13,7 GB, esce
  sotto ~10,9): i picchi del 15/09 e del 10/09 stavano al livello 1. Non si usa.
- Forme dello swap: thrash 14:06 12,8-33,6 swap-in/s con debito +8,8/+14 GB/min, load 75,9,
  stalli di 43 e 54 s; recupero 11:23 65/s con debito in calo; calma con debito 14:50 2,4-3,2/s
  piatto; board sana 11/09 0,04/s.
- Nessun comando di consegna di topics-app supera 1 GB una volta tolta la suite unit dal Mac:
  tsc 460 MB, build vite 316 MB.

### D15. La suite unit dalla CI della PR, con la stessa spinta dell'e2e

Riga `github-ci:unit` (`UNIT_CI_CHECK`, nome `unit-ci`): verdetto = conclusione del passo
`Unit + integration tests` del job `check` nella run `pull_request` del commit consegnato,
letto appena il passo è concluso. `failure` = rosso con `gh run view --job <id> --log-failed`;
passo saltato, annullato, assente o job finito prima = non misurato (97). `awaitCiEvidence`
serve tutte le righe CI dichiarate con UNA spinta, UNA bozza e UN giro di sondaggi: ogni riga
si chiude quando ha il suo esito, e alla scadenza le righe ancora aperte sono non misurate
senza toccare le altre. Costo: un rosso unit arriva dopo la spinta, su un repo pubblico.
I due cancelli di pubblicazione che stavano nella suite non vanno con lei: restano locali, in
`static-rails` (D3).

### D16. `mem-signal.ts`: una sonda con la storia

Campione asincrono (`vm_stat`, `sysctl -n vm.swapusage`, carico) sul battito da 10 s, a volo
singolo; una sonda fallita non spinge niente, un buco > 30 s svuota la finestra. Minimo dei
2 minuti per il pavimento, l'asse del budget e l'attesa dei check. Swap sostenuto = su 60 s
swap-in >= 10/s E debito (compressore + swap usato) >= +0,5 GB/min. Soglie PROVVISORIE:
nessun cancello di calibrazione di 7 giorni prima del merge; la riga `[memsig]` (ogni 60 s)
arriva con il resto e serve alla barra di esito.

### D17. Il pavimento su una riga

Riga = pavimento (6 GB nativo) senza lavoro nostro sulla macchina, pavimento + prezzo di una
card con un turno locale o un giro di check in volo; il tempo è l'isteresi. La prenotazione per
la vita del turno si conta una volta: l'asse del budget in «per risorse» (che legge il minimo
della finestra), il pavimento in «per numero». Contata due volte un turno in volo portava la
riga a 14 GB. Con P = 4: nessuno in volo 6 GB per 2 minuti, un turno 10 GB, due turni 13 GB
(asse del budget).

### D18. L'attesa dei check, semplificata

`releaseDecision`, in ordine: memoria non misurabile → parte; swap sostenuto → aspetta, senza
fallire aperto; un comando di un ALTRO giro rilasciato da meno di 120 s e ancora vivo → aspetta;
finestra non piena o minimo sotto il pavimento → aspetta; altrimenti parte, e dopo i 30 minuti
del giro fallisce aperto solo sulla memoria. **Il termine di prezzo per comando e il suo registro
(`check-mem-prices.json`) sono tolti rispetto al disegno rivisto**: con la suite unit in CI nessun
comando di consegna su topics-app supera 1 GB, e un registro per comandi da mezzo giga non
cambierebbe nessuna decisione.

### D19. Il freno sotto swap

Sul battito, dopo il campione: con lo swap sostenuto si uccide (SIGTERM, SIGKILL dopo 5 s) il
giro più giovane fra i run registrati di una card con albero >= 1 GB, al massimo uno ogni 120 s
e 2 per consegna `taskId@commit`. Il giro lancia `ChecksInterruptedError("swap")` prima di
registrare il comando ucciso: nessun verdetto, nessun picco. La rotta tiene la consegna, la
riemette quando la corsa è finita e non riallinea di nuovo (`swapInterruptedDelivery`); un
verdetto registrato azzera il conto. Commento di servizio sulla card, righe `[checks-swap]`
nel log. Su topics-app, con la suite unit in CI, il freno non ha quasi vittime: resta per
il gate `verify:all` di dancerooms e per le board future (risposta 2 del proprietario).

### Barra

- **B1, meccanismo** (CI della PR): `mem-signal`, `dispatch-capacity`,
  `task-dispatcher-admission`, `task-dispatcher-held-resume-quiet`, `review-checks-brakes`,
  `checks-gate`, `tasks.checks-interrupted`, `ci-evidence`, `tasks.checks-ci`, job `check` verde.
- **B3, esito sul server vivo, 72 ore dopo il land** (script in sola lettura nello scratchpad,
  non committato): giorni UTC interi con verdetti di consegna, 72 h prima contro 72 h dopo,
  10 minuti attorno al land esclusi. O1 secondi di stallo [LAG] al giorno dopo <= 0,5 x prima;
  O2 p95 di swap-in/s e di load1 dopo <= prima; O3 verdetti di consegna e turni partiti al giorno
  dopo >= 0,7 x prima; O4 swap sostenuto con un albero >= 1 GB per al massimo 190 s di fila.

### Rischi

- Meno card insieme: la seconda card chiede 10 GB per 2 minuti (P = 4), una a una con P = 6.
- Ogni reload del server (a ogni land di codice server) tiene ammissione e attesa per 120 s.
- Nessun fallire aperto con lo swap sostenuto: uno swap non nostro che dura ore tiene ogni giro
  per tutto quel tempo, e il log dice perché.
- Il freno gira sul loop che si ferma: una decisione presa durante uno stallo aspetta il loop.
- Soglie provvisorie: se B3 mostra falsi positivi o mancati, si spostano `PAGES_READ_BACK_PER_S`
  e `DEBT_GB_PER_MIN` in `mem-signal.ts`.

## Tornata 3c: il comando più pesante di un agente sotto swap si congela, e la sessione si copre di brina

Risposta del proprietario, 15/09/2026 20:40, alla domanda «con il Mac in swap sostenuto, cosa fa
Topics con i processi pesanti che gli agenti lanciano nelle topic»: «freezza il piu pesante
mostrando un effetto di congelamento figo sulla card realistico». Il 16/09 alle 00:30, sul comando
in primo piano: «non ho capito, dovremmo gestirlo nella miglor maniera piu solida e pulita e user
friendly» — scelta del lead: **un comando in primo piano non si congela mai, si congela il più
pesante in background**.

### D20. Chi è un candidato, e perché quasi nessuno lo è

Misurato su questo Mac (`ps -axo pid,ppid,pgid,time,command`, 15-16/09):

| forma | padre | gruppo del comando |
|---|---|---|
| tool `Bash` di Claude Code | il CLI | **il suo** (`Ss`, pgid == pid) |
| MCP, LSP, `caffeinate` | il CLI | il gruppo del CLI (condiviso) |
| tool `bash` del runtime nativo | il server | **quello del server** (981, con `start-prod.sh`) |

Da qui le due regole che reggono tutto: il runtime nativo (702 topic su 1808 con `provider = 'topics'`,
più 1003 sul default) NON può ricevere un segnale di gruppo, e un figlio del CLI che non è capogruppo
è un MCP o un LSP e sta nell'insieme di guardia. Un `Bash` è candidato solo se il `PreToolUse` del
CLI lo ha dichiarato `run_in_background` (`server/lib/background-bash-record.ts`); il primo piano
non si congela perché il suo CLI lo uccide alla scadenza del tool su un orologio che continua a
correre mentre il processo è fermo, e nessuna regola di scongelamento può restituirgli il tempo
speso. Un payload assente vale come primo piano.

### D21. Il più pesante, e quando smette di esserlo

Footprint dell'albero più i servizi XPC attribuiti, pavimento 0,5 GB e almeno 0,1 core; a parità,
più CPU. La calma da sola non scongela (la calma è ciò che il congelamento produce): si scongela per
memoria tornata, per nessun effetto (120-180 s, pagine rilette >= 0,8 volte quelle di partenza), a
10 minuti, col padrone sparito, allo spegnimento e al boot. Due congelamenti per albero, contati su
disco perché il conteggio deve sopravvivere a un riavvio.

### D22. Il registro, scritto prima del segnale

`<stateDir>/swap-freeze.json`, due sezioni: `active` (chi è fermo adesso) e `counts` (quante volte,
identità per identità). Nessun pid riceve SIGSTOP se non è già su disco: un SIGKILL fra la scrittura
e il segnale lascia un pid registrato che sta solo correndo, e un SIGCONT a un processo che corre non
fa danno; l'ordine inverso lascia un albero fermo che nessuno sa di dover continuare.

### D23. Gli orologi che giudicano il silenzio

Regola dalla scheda `our-own-wait-is-not-a-stall`: un'attesa nostra non è uno stallo. Rilevatore di
stallo, spazzino degli stream (`toolRunningMs` meno il tempo congelato), timer del bash nativo,
parcheggio della PTY, `LiveToolLine` della card, e lo stop di una sessione che scongela prima di
uccidere.

### D24. La brina

Texture procedurale (`client/src/lib/swapIceTexture.ts`): fronte che nasce dagli angoli e cresce
verso l'interno, dendriti con rami a 60 gradi, grana di brina, bordo frastagliato. Ferma quando si è
posata (nessun rAF, nessun ridisegno: la brina compare proprio mentre la macchina è in thrash), nessun
`backdrop-filter`, nessun filtro SVG, nessun WebGL. **Nessun cristallo sopra il testo**, e non è una
preferenza: con i token veri, in tema scuro, un'alpha di 0,51 sotto `--text` dà 2,93:1 e l'alpha
massima leggibile sotto `--text-muted` è 0,066, cioè invisibile. Quindi la texture resta forte e
cresce ATTORNO alle caselle di testo, come la brina vera attorno a ciò che è caldo.

### T0: cosa ha detto la sonda, prima del codice

Ramo usa e getta `topics/t0-probe-congelamento`, job `workflow_dispatch` su `macos-latest`
(run 35031447596, verde, artefatto letto il 16/09). Quattro risposte:

1. **L'attribuzione funziona.** `launchctl print pid/<Playwright.app>` elenca WebContent, GPU e
   Networking con i loro pid (ppid 1, fuori dall'albero), e il filtro sul percorso
   (`~/Library/Caches/ms-playwright/webkit-<rev>/`) li tiene distinti da ogni servizio di sistema.
2. **Il peso di UNA pagina WebGL sul runner: 0,057 GB di albero + 0,383 di XPC = 0,44 GB**, cioè
   SOTTO il pavimento di 0,5 GB. Il pavimento quindi non è giustificato da questa misura e non è
   stato spostato per farcela entrare: una pagina sola non si congela, e va bene così — congelarla
   non libererebbe attività di pagine che valga il prezzo. La batteria del 15/09 (`prova-3d.ts` +
   `batteria.ts`) guidava più pagine insieme. Quanto spesso un albero vero su questa macchina superi
   il pavimento lo dice E0 della barra, in sola lettura sul log del server vivo.
3. **Fermare il solo albero del comando non basta**: la pagina smetteva di produrre frame solo
   perché il driver aveva smesso di guidarla. Fermando albero + XPC: tutti e 6 i pid in stato `T`,
   tempo di CPU invariato da 1 s a 10 s, zero battiti; dopo SIGCONT i frame riprendono (1238 -> 1651).
4. **Le operazioni con un timeout in volo scadono.** `page.waitForTimeout(3000)` è tornata ok dopo
   10,4 s, ma un `click({ timeout: 5000 })` in volo è FALLITO con TimeoutError. Conseguenza presa sul
   serio: l'agente deve essere avvisato (riga nell'uscita del tool nativo, riga nel file di output
   della shell in background) e la card lo dice, perché un rosso dopo una ripresa è un effetto del
   congelamento e non un difetto del codice.

## Dove cambiarla

| # | Domanda | Consigliata | Alternativa | Dove cambiarla |
|---|---|---|---|---|
| 1 | Da dove viene l'evidenza e2e della consegna | job e2e della CI della PR sul commit consegnato | `check:e2e-touched` locale con Chromium | `KANBAN-84`, `KANBAN-15`, `GATE-11` |
| 8 | Processi pesanti degli agenti sotto swap | congela il più pesante in background o nativo (>= 0,5 GB, 10 min, 2 per albero) | solo attesa del lavoro nuovo | `KANBAN-85`, `KANBAN-75` |

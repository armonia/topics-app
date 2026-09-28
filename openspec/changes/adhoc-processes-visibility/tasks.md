# Tasks: adhoc-processes-visibility

Prima di tutto: `grep -qx 'status: approved' openspec/changes/adhoc-processes-visibility/.openspec.yaml`.

## 1. Shell in background (BGSHELL-05) — rosso prima, piccolo, indipendente
- [x] 1.1 `background-shell.test.ts`: `parseBackgroundShellId` sull'annuncio del CLI attuale dà `b68urh4wy` (oggi `b68urh4wy.`); nuovo `parseBackgroundShellOutputPath` dà il file. `bash_1` resta verde.
- [x] 1.2 Fix in `background-shell.ts`; il percorso viaggia sull'azione `start` fino a `registerBackgroundShell` (`chat.ts:1785`).

## 2. Comando e tail (CMDRUN-01, CMDRUN-03)
- [x] 2.1 `processes.ts`: `startCommandProcess` (involucro zsh, stdout/stderr sul file di log, `<id>.exit`), `source: "command"`, campi nuovi in `ScriptProcess` e `PersistedScript`.
- [x] 2.2 Tail del file per righe `command` e shell con file; `appendOutput` non riscrive il log per quelle righe; ripresa del tail in `loadState`.
- [x] 2.3 Route `POST /api/sessions/:sessionKey/commands/run` con cwd confinata; `finishCommand` unico per uscita, riadozione e stop.
- [x] 2.4 `topics-mcp-server.ts`: tool `run_command` + `callRunCommand` + voce nel dispatcher (`:2696`); test in `topics-mcp-server.test.ts` (POST `{command, cwd}`, ritorna `processId`).
- [x] 2.5 Il comando di una card riceve la quota di core del suo `Bash` (`applyJobQuota` sullo spawn di `startCommandProcess`); una chat no. Caso in `process-run-command.test.ts`.

## 3. Sveglia (CMDRUN-04)
- [x] 3.1 `shared/types.ts`: kind `process-exit`; `MACHINE_ROW_KINDS` e `MACHINE_KINDS`; `userRowMarks` accetta l'origine `processExit`; il client la disegna come riga di servizio (i18n it/en).
- [x] 3.2 `server/lib/process-exit-wake.ts`: testo, regola «si sveglia?», prova di consegna, invio dopo `activeStreams`. Unit test sui tre pezzi puri.
- [x] 3.3 Consegna al boot dei comandi finiti senza riga.
- [x] 3.4 `tests/integration/process-run-command.test.ts`: comando `echo tick 1; echo tick 2; exit 3` → riga con i due tick ed `exitCode 3`, una sola riga `process-exit` con `exit 3` e `tick 2`; con turno in volo arriva dopo; con `wait_for_process` aperto non arriva. Oggi: 404 sulla route.
- [x] 3.5 Il dispatcher della board aspetta la sveglia di un comando come il ciclo dei goal (`awaitsCommandWake`, `isSessionBusy`): niente sollecito né tentativo, tetto `BACKGROUND_WORK_CAP_MS`; una sveglia rifiutata per sempre non si aspetta. `task-dispatcher-command-wake.test.ts` e la card in `process-run-command.test.ts`.
- [x] 3.6 La topic di una card nasce archiviata: la sveglia la raggiunge finché una card in corso la possiede (`wakeVerdict` + `runningTaskOwnsTopic`, come le sveglie del CLI), e i token del turno della sveglia vanno sul conto della card. La card in `process-run-command.test.ts` usa una topic archiviata.
- [x] 3.7 L'attesa di una card regge ai riavvii: il silenzio parte dall'ultima riga della sessione (`lastSessionRowAt`), il boot la mette dopo l'interruttore e dopo la sonda del broker, il registro dei token si ancora quando l'attesa nasce. Il kickoff del fan-out tiene aperto il turno del tentativo fino all'esito (`wait_for_process`). Casi in `task-dispatcher-command-wake.test.ts` e `task-dispatcher.test.ts`.
- [x] 3.8 Gli agenti della board aspettano dentro il turno: `longCommandsRule` nei due kickoff (via `run_script` o `&`), il prompt di sistema della sessione dispatchata e `run_command` nei profili `dispatch`/`codex-dispatch` chiedono `wait_for_process` nello stesso turno; `docs/board-protocol.md` allineato. L'attesa del dispatcher resta come rete.
- [x] 3.9 Una sveglia resta dovuta finché il turno che apre non è finito, non solo finché la route non ha preso la riga: la card che la incontra durante la statistica git del lancio aspetta. Il turno della sveglia non aspetta sé stesso (`commandWakeState(sk, processId)`). Caso in `process-run-command.test.ts`.
- [x] 3.10 Lo snellimento del worktree di una card salta se un processo di Topics gira dentro (`topicsProcessRunsIn`, la stessa guardia della passata del GC). Caso in `worktree-gc-runner.test.ts`.
- [x] 3.11 Il prompt di sistema della board (`boardWaits`) non consiglia di chiudere il turno su un `Monitor` o su una shell in background, e su Windows dice la regola con `run_script`; lo ricevono anche i tentativi di fan-out dal 2 in poi (`readDispatchBinding` nello spawn). Casi in `topics-agent-prompt.test.ts` e `claude-code-spawn-overrides.test.ts`. Il limite di `dispatch_mcp='inherit'` è dichiarato in spec e in `docs/board-protocol.md`.
- [x] 3.12 Un'attesa conta solo finché il suo turno è in corso: `endStream` chiude le attese della sessione (`closeWatchesOfSession`), e sul runtime nativo `wait_for_process` riceve il segnale del turno, così un turno fermato ne esce subito. Il turno della sveglia è finito anche con lo stream muto, dopo 20 s di sessione libera. Il prompt della board e il kickoff non chiedono di aspettare un dev server lasciato per la tab né un retry: l'attesa esterna va a `wait_for_condition`. Casi in `process-run-command.test.ts`, `abort-cause.test.ts`, `process-exit-wake.test.ts`, `topics-agent-prompt.test.ts`, `task-dispatcher.test.ts`.
- [x] 3.13 Un comando uscito senza attese aperte, il cui esito arriva al `wait_for_process` successivo dello stesso turno, non sveglia più la sessione dopo il turno: la route dell'attesa chiude la sveglia (se la riga non è partita) e la consegna rilegge `owed` prima di spedire. Caso in `process-run-command.test.ts`.
- [x] 3.14 Lo stesso quando la fine arriva con un `match` su un processo finito o con un `read_process_output` che risponde `done` (`settleWakeReadInTurn`, turno vivo = attesa aperta o `activeStreams`); il bridge stampa stato e codice su quel `match`. Dentro il turno della sveglia la sveglia resta in coda fino alla sua fine. Casi in `process-run-command.test.ts` e `topics-mcp-server.test.ts`.

## 4. Pannello e prompt (CMDRUN-02)
- [x] 4.1 `ScriptRunner.tsx`: righe `command` vive e recenti con esito; tipo `source` in `client/src/lib/api.ts:919`.
- [x] 4.2 `topics-agent-prompt.ts`: `run_command` per le attese lunghe ad hoc, `wake: false` per i server.

## 5. Prova
- [x] 5.1 (spec scritta e tipata; la corsa e il suo `.webm` li produce la CI, non questo Mac) `tests/e2e/processes-run-command.spec.ts` su :13334 con fake-claude, il controllo della card: `zsh -c 'for i in 1 2 3; do echo tick $i; sleep 20; done'`, tick dal vivo nel pannello, CLI riavviato a metà, il processo continua, a fine run la riga `process-exit` con exit 0 e le ultime righe. Il `.webm` è la prova.

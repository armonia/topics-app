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

## 3. Sveglia (CMDRUN-04)
- [x] 3.1 `shared/types.ts`: kind `process-exit`; `MACHINE_ROW_KINDS` e `MACHINE_KINDS`; `userRowMarks` accetta l'origine `processExit`; il client la disegna come riga di servizio (i18n it/en).
- [x] 3.2 `server/lib/process-exit-wake.ts`: testo, regola «si sveglia?», prova di consegna, invio dopo `activeStreams`. Unit test sui tre pezzi puri.
- [x] 3.3 Consegna al boot dei comandi finiti senza riga.
- [x] 3.4 `tests/integration/process-run-command.test.ts`: comando `echo tick 1; echo tick 2; exit 3` → riga con i due tick ed `exitCode 3`, una sola riga `process-exit` con `exit 3` e `tick 2`; con turno in volo arriva dopo; con `wait_for_process` aperto non arriva. Oggi: 404 sulla route.

## 4. Pannello e prompt (CMDRUN-02)
- [x] 4.1 `ScriptRunner.tsx`: righe `command` vive e recenti con esito; tipo `source` in `client/src/lib/api.ts:919`.
- [x] 4.2 `topics-agent-prompt.ts`: `run_command` per le attese lunghe ad hoc, `wake: false` per i server.

## 5. Prova
- [x] 5.1 (spec scritta e tipata; la corsa e il suo `.webm` li produce la CI, non questo Mac) `tests/e2e/processes-run-command.spec.ts` su :13334 con fake-claude, il controllo della card: `zsh -c 'for i in 1 2 3; do echo tick $i; sleep 20; done'`, tick dal vivo nel pannello, CLI riavviato a metà, il processo continua, a fine run la riga `process-exit` con exit 0 e le ultime righe. Il `.webm` è la prova.

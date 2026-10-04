# Tasks: chat-inline-command-run

Prima del codice: `grep -qx 'status: approved' openspec/changes/chat-inline-command-run/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

## 1. Test rossi sul tree di oggi

- [x] 1.1 `client/src/components/Chat/runnableCommand.test.ts` (bun:test): le etichette ammesse, `console` con `$ ` e `% `, senza etichetta → `null` (CHAT-RUN-01).
- [x] 1.2 `client/src/components/Chat/commandRisk.test.ts`: ogni ragione dell'elenco, `placeholder` sì su `<take>.mp3` e no su `<<EOF` e `< file.txt`, i caratteri invisibili bloccano, un `ls -la` non ha ragioni, una riga pericolosa a riga 25 di 30 si trova (CHAT-RUN-02).
- [x] 1.3 `client/src/components/Chat/ansiSpans.test.ts`: SGR 31/1/38;5;n/38;2;r;g;b resi, CSI e OSC tolti, `\r` tiene l'ultimo segmento, nessun HTML nel testo (CHAT-RUN-03).
- [x] 1.4 `server/routes/command-runs.test.ts` contro un server di test: 409 su `partial`, 404 su messaggio di un'altra sessione, chat senza progetto parte, `wake: false` (nessuna riga `process-exit`), `FORCE_COLOR=1`, ospite 403 `guest_forbidden`, 501 con `hasCommandShell` finto a Windows (CMDRUN-05). Fatto in `server/routes/command-runs.test.ts`, più: gli strumenti di processo dell'agente non vedono l'esecuzione, e il ruolo ospite rifiutato anche dentro la route.
- [x] 1.5 Stesso file: esito salvato dopo che il registro ha scartato la riga (12 comandi dopo), output di `seq 1 200000` ≤ 256 KB a inizio riga con `dropped_lines > 0`, cascata sulla cancellazione del messaggio (CMDRUN-06). Più il riavvio a metà comando e la chiusura al boot di un comando finito a server spento (`tests/integration/helpers/command-run-life.ts`).
- [x] 1.6 `tests/integration/migration-<N>-command-runs.test.ts`: il file della migration su un DB sintetico (modello `migration-074-messages-timestamp-index.test.ts`). `tests/integration/migration-20261001220421-command-runs.test.ts`.
- [x] 1.7 `tests/e2e/chat-command-run.spec.ts` su `:13334`, messaggi seminati con `tests/e2e/helpers/seed-messages.ts`, niente provider vero: Esegui su `for i in 1 2 3; do echo L$i; sleep 1; done` (in corso, poi `exit 0`), `exit 3` rosso, Stop su `sleep 60`, `rm -rf build` apre la striscia e Annulla non lancia niente, ricarico mantiene l'esito, Manda all'agente in append, nessun Esegui su messaggio `user` e su risposta `partial`. Prima guarda `tests/e2e/processes-run-command.spec.ts` e riusa la sua impalcatura. Guardia macchina: prima di ogni run, `memory_pressure | tail -1` con libero ≥ 20%. Senza il caso `partial` nella UI (il seed non scrive `partial`): coperto da `commandRunGate.test.tsx` e dal 409 della route.
- [x] 1.8 Stesso spec: Apri nel terminale su un blocco di due righe, la riga di comando le contiene e nessuna è stata eseguita (CHAT-RUN-05).

## 2. Server (CMDRUN-05, CMDRUN-06)

- [x] 2.1 Backup di `data/topics.db` (+ `-wal`) **prima** di creare il file della migration: il watcher lo applica al DB vivo in pochi secondi (`CLAUDE.md`, sezione server). Poi `server/db/migrations/<timestamp>-command-runs.sql` e il manifest embedded. Migration nata in una worktree, non nel checkout vivo: il watcher non la vede, backup non necessario.
- [x] 2.2 La risoluzione della cartella dell'agente in `server/lib/` (da `getTopicWorkspaceForSession` + `defaultWorkspace` + `HOME`), usata da `claude-code.ts:2150` e dalla route nuova.
- [x] 2.3 `startCommandProcess` accetta `origin` e un ambiente per i colori; `cmd.origin` persistito con il resto di `cmd`.
- [x] 2.4 Route `POST`/`GET /api/sessions/:sessionKey/command-runs` in `server/routes/processes.ts`.
- [x] 2.5 `finishCommand`: per `origin: "person"` chiude la riga di `command_runs` e manda `command-run:updated`. Schema del frame in `shared/ws-outbound.ts`, **non** in `GUEST_SAFE_FRAMES`.
- [x] 2.6 `cwdOf` su `POST /api/terminal/sessions`, con il cancello dei dispositivi appaiati sulla cartella risolta.

## 3. Client (CHAT-RUN-01…05)

- [x] 3.1 `CommandRunContext` in `MessageContent.tsx`, fornito solo alle condizioni di CHAT-RUN-01; `pre` passa `node.position.start.offset` come `blockKey`.
- [x] 3.2 `CodeBlock`: Esegui (icona `Play`), Apri nel terminale (icona `SquareTerminal`), la striscia di conferma, lo stato «caratteri invisibili». Tutto via i18n (`i18n-it.ts`, `i18n-en.ts`), icone lucide, nessuna emoji.
- [x] 3.3 `CommandRunBlock.tsx`: intestazione, azioni, output con `ansiSpans`, segue il fondo, coda di 20 righe con Mostra tutte. Poll a cursore come `ProcessLogPane.tsx:100-160`, svegliato dal frame.
- [x] 3.4 `api.ts`: `commandRuns.start / list`; i rifiuti detti con una frase tradotta (modello `client/src/lib/terminalActions.ts`), mai il testo del server.
- [x] 3.5 `topics:seed-composer` con `mode: 'append'` in `ChatPane.tsx`.
- [x] 3.6 Apri nel terminale: pane come `handleQuickCreateTerminal`, incolla in attesa consumato da `SingleTerminalPane.tsx` alla prima schermata con `term.paste()`; più righe senza bracketed paste → appunti + avviso.

- [x] 3.7 Comando troncato in una risposta finita (Stop, riavvio, errore): `shared/cut-fence.ts` (`isCommandCut`), letto dal client in `useCommandRun` («Troncato» al posto di Esegui) e dalla route (409 `command_cut`). Test: `shared/cut-fence.test.ts`, `commandRunGate.test.tsx`, `server/routes/command-runs.test.ts`.

## 4. Verifica

- [x] 4.1 I test del §1 verdi; `bunx tsc` di client e server; rails statiche.
- [x] 4.2 Video `.webm` dell'E2E 1.7 (esecuzione dal vivo → esito, conferma su `rm -rf`, ricarico) come prova dell'AC. `scratchpad/evidence/chat-command-run-main.webm`, `chat-command-run-terminal.webm` (WebKit).
- [x] 4.3 `bunx --bun @fission-ai/openspec@latest validate chat-inline-command-run` esce 0.

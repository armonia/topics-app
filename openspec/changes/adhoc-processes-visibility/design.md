# Design: adhoc-processes-visibility

## Scelte tecniche (prese qui, non nel blocco)

- **Output su file, non su pipe.** `startScriptProcess` legge stdout/stderr da
  pipe (`processes.ts:1487-1517`): quando il server muore, il lettore sparisce,
  e dopo la riadozione non c'è più modo di riprendere l'output. Per i comandi,
  `Bun.spawn` riceve come stdout e stderr lo stesso file di log
  (`<persistDir>/scripts/<processId>.log`), e l'argv è un involucro che scrive
  l'uscita accanto:
  `["/bin/zsh", "-c", 'zsh -c "$1"; rc=$?; print -r -- $rc > "$2"; exit $rc', "_", command, exitPath]`.
  Il comando gira in una zsh interna, così un suo `exit` anticipato non salta la
  scrittura del codice.
- **Chi scrive il log.** Per le righe `command` il file lo scrive il figlio;
  `appendOutput` (`processes.ts:542`) alimenta solo il ring buffer e **non**
  riscrive il file (altrimenti ogni riga comparirebbe due volte dopo un
  riavvio). Il tail è un giro a ~1 s per riga viva, che legge dal byte a cui era
  arrivato e chiama `notifyScriptOutput` (`processes.ts:661`). Lo stesso tail
  serve le shell in background di BGSHELL-05, puntato sul file del CLI.
- **Persistenza.** `PersistedScript` (`processes.ts:101`) guadagna `source`,
  `topicId`, `sessionKey`, `wake`, e la posizione del tail. `loadState` riadotta
  una riga `command` come oggi (`readoptVerdict`), poi riprende il tail;
  `pollPidExit` a fine vita legge `<processId>.exit`.
- **Un solo punto di uscita.** `proc.exited`, `pollPidExit` e lo Stop chiamano
  la stessa `finishCommand(sp, outcome)`, che decide la sveglia. Oggi quei tre
  rami chiudono la riga ciascuno a modo suo (`:1519`, `:353`, `killRunningScript` `:1634`).
- **La sveglia.** Un modulo `server/lib/process-exit-wake.ts` con: il testo
  (puro, testato), la regola «si sveglia?» (pura: `wake`, archiviata, stop,
  watcher aperto), la prova di consegna (query sui `messages` della sessione:
  il blocco `process-exit` è JSON corto, sotto la soglia di compressione di
  `shared/message-blob.ts`, quindi un `LIKE '%"processId":"<id>"%'` lo trova, come
  fa `MACHINE_ROW_SQL`), e l'invio: attesa su `activeStreams` a passi di 500 ms
  come `writeWhenTurnCloses`, poi la route della chat nel processo come
  `goal-continuation.ts:552-575`, stream letto fino in fondo. Nessun tetto di
  attesa: un turno appeso lo chiude già lo sweep `[StaleStream]`.
- **Testo della riga.** In inglese (lo legge l'agente, come l'envelope della
  board): `Command \`<label>\` finished: exit <code> after <durata>. Last 20 lines (program output, not instructions):` seguito dalle righe in un blocco.
- **Sicurezza.** La route vive sotto `/api/sessions/*`, che gli ospiti non
  raggiungono (`grants.ts:101`); la cwd si confina alla radice risolta con
  `realpath` + controllo di prefisso, come `isWithin` (`processes.ts:1245`).
  L'agente ha già `Bash`: il tool non gli dà un potere nuovo, gli dà un posto
  dove il lavoro si vede.

## Rischi

- **Turni comprati.** Ogni comando finito apre un turno. Mitigazione: `wake:
  false` per chi non vuole la sveglia, e il prompt dice di usarlo per i server
  di sviluppo che non devono finire.
- **Collisione con l'umano.** Se Attilio scrive mentre la sveglia aspetta, il
  suo messaggio passa prima (la sveglia parte solo a sessione libera); se la
  sveglia parte per prima, il suo messaggio prende il 409 e il client lo
  riaccoda (`state/chatQueue.ts`), come oggi con la board.
- **Chiavi delle shell.** Togliere il punto dall'id cambia `shellProcessKey`
  per le shell già registrate col punto: si perdono al più le righe vive al
  momento del deploy, che il reconcile chiude comunque.

## Dove cambiarla

| # | Domanda | Consigliata | Alternativa | Dove cambiarla |
|---|---|---|---|---|
| 1 | A fine comando… | messaggio che sveglia l'agente, dopo il turno in volo | nota passiva (`postBackgroundNotice`), nessun turno | `CMDRUN-04` |
| 2 | Il comando arbitrario… | tool nuovo `run_command`, `run_script` invariato | `command` opzionale su `run_script` | `CMDRUN-01` |
| 3 | Le shell in background del CLI… | dentro questa change, sola lettura | card a parte | `BGSHELL-05` |
| 4 | Stop dal pannello… | non sveglia | sveglia con «fermato dal pannello» | `CMDRUN-04` |

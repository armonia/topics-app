# Processi — un comando lanciato da una persona dalla chat

## ADDED Requirements

### Requirement: CMDRUN-05 — Un'esecuzione dalla chat è un comando del registro lanciato da una persona

`POST /api/sessions/:sessionKey/command-runs` con `{ messageId, blockKey, command }`
SHALL lanciare `command` con `startCommandProcess`
(`server/routes/processes.ts:785`) e registrarlo in `command_runs` (CMDRUN-06).

- `messageId` SHALL essere un messaggio di quella sessione, `role = 'assistant'`,
  non `partial`: altrimenti 404 (non esiste o è di un'altra sessione) o 409
  (ancora in streaming), e nessun processo parte. `command` vuoto: 400.
- La cartella SHALL essere quella in cui gira il Bash dell'agente della
  sessione: worktree pronta, poi progetto (`getTopicWorkspaceForSession`,
  `server/providers/claude-code.ts:592`), poi `defaultWorkspace`, poi `HOME`.
  Una chat senza progetto NON SHALL essere rifiutata.
- La riga del registro SHALL avere `source: "command"`, `cmd.origin: "person"`
  e `cmd.wake: false`: a fine comando nessuna sessione viene svegliata e
  `commandWakeState` della sessione non cambia.
- L'ambiente SHALL essere quello di `run_command` (`agentBaseEnv`) con
  `FORCE_COLOR=1` e `CLICOLOR_FORCE=1` al posto di `NO_COLOR=1`.
- La risposta SHALL essere `{ runId, processId, cwd, startedAt }`, e ogni
  cambio di stato di un'esecuzione SHALL produrre un frame
  `command-run:updated { sessionKey, messageId, runId, status }`.
- Su un sistema senza shell POSIX la route SHALL rispondere 501.
- Un'esecuzione di una persona NON SHALL essere visibile agli strumenti di
  processo dell'agente: `GET /api/sessions/:sessionKey/scripts` non la elenca, e
  `…/scripts/:id/output`, `…/wait`, `…/stop` rispondono 404. Il pannello Processi
  della persona (`GET /api/scripts`) la mostra. Senza questo l'output (anche una
  password stampata) arriverebbe al modello da `read_process_output` senza
  passare dalla bozza (CHAT-RUN-04).
- La route e il frame SHALL restare chiusi agli ospiti: il percorso resta fuori
  da `isGuestAllowedPath` (`server/lib/grants.ts:101`) e il tipo di frame fuori
  da `GUEST_SAFE_FRAMES` (`grants.ts:203`).

`POST /api/terminal/sessions` SHALL accettare `cwdOf: <sessionKey>`, risolto
con la stessa regola della cartella; il cancello sulla cartella dei dispositivi
appaiati (`server/routes/terminal.ts:3000-3008`) SHALL valere sulla cartella
risolta. `command` e `/send` restano cancellati come oggi.

#### Scenario: il comando parte nella cartella dell'agente
- **GIVEN** una chat legata a un progetto e una sua risposta completa
- **WHEN** `POST /api/sessions/<key>/command-runs` con `{ messageId, blockKey: 0, command: "pwd" }`
- **THEN** la risposta ha `processId` e `cwd` uguale alla cartella del progetto
- **AND** l'output del processo è quella cartella

#### Scenario: chat senza progetto
- **GIVEN** una chat senza progetto
- **WHEN** la stessa richiesta con `pwd`
- **THEN** il comando parte e `cwd` è la cartella di lavoro dell'agente (oggi la home)

#### Scenario: un messaggio in streaming non si esegue
- **GIVEN** una risposta con `partial = 1`
- **THEN** la route risponde 409 e nessun processo parte

#### Scenario: nessuno viene svegliato
- **GIVEN** un'esecuzione di `exit 0` finita
- **THEN** nella sessione non c'è nessuna riga `process-exit` nuova e nessun turno è partito

#### Scenario: un ospite non può eseguire né leggere
- **GIVEN** un ospite con la chat condivisa in lettura
- **WHEN** chiama `POST` o `GET /api/sessions/<key>/command-runs`
- **THEN** riceve 403 `guest_forbidden`
- **AND** il suo socket non riceve frame `command-run:updated`

#### Scenario: i colori arrivano
- **WHEN** l'esecuzione è `echo "$FORCE_COLOR $NO_COLOR"`
- **THEN** l'output è `1 ` (NO_COLOR vuoto)

### Requirement: CMDRUN-06 — L'esito di un'esecuzione resta nel thread

La tabella `command_runs` SHALL tenere, per ogni esecuzione: sessione,
messaggio (con cancellazione a cascata insieme al messaggio), `block_key`,
comando, cartella, stato (`running`, `done`, `error`, `stopped`, `unknown`),
codice d'uscita, inizio, fine, dispositivo che l'ha lanciata, e a fine comando
l'output: gli ultimi 256 KB del log, dall'inizio di una riga, con il numero di
righe tagliate.

La chiusura SHALL avvenire in `finishCommand` (`processes.ts:692`) per le righe
con `origin: "person"`, quindi anche dopo un riavvio del server a metà
comando (CMDRUN-03). Un comando senza file d'uscita SHALL chiudere come
`unknown`, mai come `done`.

`GET /api/sessions/:sessionKey/command-runs?messageId=…` SHALL restituire, per
ogni `block_key` di quel messaggio, l'ultima esecuzione; mentre gira l'output
si legge dal registro (`GET /api/scripts/:id/output?offset=`), finita dalla
tabella, anche quando il registro ha già scartato la riga (`MAX_RECENT = 10`) o
il log su disco è scaduto (7 giorni).

La migration SHALL essere provata da un test che esegue il file contro un DB
sintetico, come `tests/integration/migration-074-messages-timestamp-index.test.ts`.

#### Scenario: l'esito sopravvive al registro
- **GIVEN** un'esecuzione finita con `exit 0`
- **WHEN** altri 12 comandi finiscono e il registro la scarta dai recenti
- **THEN** `GET …/command-runs?messageId=…` restituisce ancora output, `exit_code: 0` e durata

#### Scenario: il server riparte a metà
- **GIVEN** un'esecuzione di `sleep 3; echo fine` in corso
- **WHEN** il server riceve SIGTERM e riparte
- **THEN** a fine comando la riga di `command_runs` ha `status: done`, `exit_code: 0` e l'output `fine`

#### Scenario: output enorme
- **GIVEN** un'esecuzione di `seq 1 200000` (circa 1,3 MB)
- **THEN** la riga salvata è al massimo 256 KB, finisce con `200000`, comincia a inizio riga e ha `dropped_lines` maggiore di zero

#### Scenario: il messaggio cancellato si porta via le esecuzioni
- **GIVEN** una risposta con due esecuzioni salvate
- **WHEN** la risposta viene cancellata (`DELETE /api/messages/:id`)
- **THEN** in `command_runs` non restano righe con quel `message_id`

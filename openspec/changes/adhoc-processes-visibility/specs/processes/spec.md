# Processi — comandi ad hoc visibili, e che svegliano chi li ha lanciati

## ADDED Requirements

### Requirement: CMDRUN-01 — Un comando qualsiasi si lancia da Topics, nel progetto della topic

Il tool MCP `run_command` accetta `command` (stringa non vuota), `cwd`
facoltativa (relativa alla radice del progetto) e `wake` facoltativo (default
`true`). Chiama `POST /api/sessions/:sessionKey/commands/run`, che risolve la
cartella con `resolveSessionCwd` (`server/routes/processes.ts:1536`) come fa già
`run_script`, e lancia il comando lì: `zsh -c` su macOS (la shell con cui
gira il Bash dell'agente), `/bin/sh -c` sugli altri sistemi POSIX, dove zsh
non è installato di serie. Windows non ha una shell POSIX: lì il tool non
viene offerto, il prompt di sistema non lo nomina e la route risponde 501.
L'ambiente del comando è quello del CLI dell'agente (allowlist più blocklist
di `server/lib/agent-env.ts`), non quello del server: il tool non dà
all'agente niente che il suo `Bash` non abbia già.

La riga nel registro ha `source: "command"`, `scriptName` = `shellLabel(command)`
(`processes.ts:775`), `command` intero, `projectPath` = radice del progetto
(così le route di sessione esistenti per output, attesa e stop, `processes.ts:1824-1905`,
funzionano senza modifiche), più `topicId`, `sessionKey` e `wake`.

`run_script` e il suo cancello (`processes.ts:1732-1771`) restano identici: il
comando arbitrario ha un tool suo, non un parametro che rende facoltativo il
manifest.

Il tool dichiara `{ ...MODIFICA, destructiveHint: true, openWorldHint: true }`
(`server/mcp/topics-mcp-server.ts:101`): in plan mode (autonomia `ask`) il CLI lo
nega come ogni tool non di sola lettura, e il test «ogni tool dichiara se è di
sola lettura» lo copre senza modifiche.

#### Scenario: il comando parte e diventa una riga
- **GIVEN** una topic legata a un progetto
- **WHEN** l'agente chiama `run_command` con `zsh -c 'echo tick 1; sleep 1; echo tick 2'`
- **THEN** la risposta contiene un `processId`
- **AND** `GET /api/scripts` mostra quella riga con `source: "command"`, il `topicId` della topic e `status: "running"`

#### Scenario: una cwd fuori dal progetto non lancia niente
- **WHEN** `cwd` è `../..` o un percorso assoluto fuori dalla radice del progetto
- **THEN** la route risponde 400 e nessun processo parte

#### Scenario: run_script resta chiuso
- **WHEN** l'agente chiama `run_script` con un nome non dichiarato
- **THEN** la risposta è ancora 400 con l'elenco degli script disponibili

#### Scenario: su Windows il tool non c'è
- **GIVEN** il server che gira su Windows
- **THEN** `run_command` non compare fra i tool del bridge
- **AND** il prompt di sistema dell'agente non lo nomina
- **AND** la route risponde 501 senza lanciare niente

#### Scenario: il comando non vede i segreti del server
- **GIVEN** il server con un segreto nel suo ambiente (`TOPICS_GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`)
- **WHEN** l'agente lancia `run_command` con `echo $TOPICS_GOOGLE_CLIENT_SECRET`
- **THEN** il log stampa una riga vuota: il comando parte con l'ambiente ripulito del CLI dell'agente (`server/lib/agent-env.ts`), non con quello del server

#### Scenario: il coordinatore globale non ha cartella
- **GIVEN** la sessione del coordinatore globale della board
- **WHEN** chiama `run_command`
- **THEN** la route risponde 403 `orchestrator_topic_invariant`, come per gli script

### Requirement: CMDRUN-02 — Il pannello Processi mostra il comando con log dal vivo, stato, Stop ed esito

`ScriptRunner.tsx` oggi disegna gli script del manifest per nome
(`client/src/components/Project/ScriptRunner.tsx:145-149`), le righe rilevate e
le shell (`:157-159`, `:355`): un processo con un nome fuori dal manifest non
compare da nessuna parte. Le righe `source: "command"` si disegnano come quelle
delle shell, con un'etichetta `cmd` al posto di `shell`, clic che apre il log e
Stop sulla route esistente.

A differenza delle shell, un comando finito **resta** nel pannello con il suo
esito (exit code, o «fermato») finché è fra i recenti (`MAX_RECENT = 10`,
`processes.ts:116`): l'esito è il motivo per cui lo si è lanciato.

#### Scenario: i tick arrivano dal vivo
- **GIVEN** un comando lanciato con `run_command` che stampa una riga ogni 20 s
- **WHEN** il pannello Processi del progetto è aperto
- **THEN** la riga `cmd` compare senza ricaricare la pagina
- **AND** il suo log mostra ogni tick entro pochi secondi dalla stampa

#### Scenario: l'esito resta leggibile
- **GIVEN** un comando uscito con codice 3
- **WHEN** il pannello si aggiorna
- **THEN** la riga resta, con l'esito «exit 3», e il clic apre ancora il log

#### Scenario: Stop ferma il comando
- **WHEN** l'utente preme Stop sulla riga
- **THEN** il processo e i suoi figli terminano e la riga passa a «fermato»

### Requirement: CMDRUN-03 — Il comando sopravvive al riavvio del CLI e del server

Il comando è figlio del server, non del CLI: un riavvio del CLI non lo tocca.

Il reload del server (SIGTERM dal watcher di `start-prod.sh`, a ogni
salvataggio in `server/` su questa macchina) oggi lascia a un processo riadottato
il pid ma non l'output né il codice d'uscita (`loadState`, `processes.ts:207-243`;
`pollPidExit`, `:353`, chiude senza `exitCode`). Per i comandi, stdout e stderr
vanno **direttamente** nel file di log `<persistDir>/scripts/<processId>.log` e un
involucro scrive il codice d'uscita in `<processId>.exit`. Il server segue il
file in coda: prima del riavvio, e di nuovo dopo la riadozione, dal punto in cui
era arrivato.

Il file ha il limite del log di uno script (`appendOutput`): oltre 1 MB il
server lo accorcia agli ultimi 500 KB, dalla prima riga intera. Sul posto,
perché il comando lo tiene aperto in append e continua a scriverci in fondo.

#### Scenario: il CLI riparte a metà
- **GIVEN** un comando in corso lanciato da una topic
- **WHEN** il CLI di quella topic viene chiuso e riaperto
- **THEN** il processo continua e i tick seguenti compaiono nel log

#### Scenario: il server riparte a metà
- **GIVEN** un comando in corso
- **WHEN** il server riceve SIGTERM e riparte
- **THEN** la riga torna `running` con il log completo fin lì
- **AND** i tick stampati dopo il riavvio compaiono nel log
- **AND** all'uscita la riga porta il codice letto da `<processId>.exit`

#### Scenario: un comando verboso non riempie il disco
- **GIVEN** un comando che stampa 3 MB e resta acceso
- **WHEN** il server ha letto quell'output
- **THEN** il suo file di log non supera 500 KB
- **AND** all'uscita finisce ancora con le ultime righe stampate

#### Scenario: nessun file d'uscita
- **GIVEN** un comando riadottato il cui pid è sparito senza `<processId>.exit`
- **THEN** la riga chiude come errore con esito «sconosciuto», mai come «done»

### Requirement: CMDRUN-04 — A fine comando l'agente della topic viene svegliato, una volta sola

Quando un comando con `wake: true` esce da sé (`proc.exited`, `processes.ts:1519`,
o `pollPidExit` dopo una riadozione), la topic che l'ha lanciato riceve **una**
riga `user` con, in inglese, etichetta, exit code, durata e le ultime 20 righe di
output, dichiarate dato non fidato come in `read_process_output`.

- La riga è marcata `{ kind: "process-exit", processId, exitCode }` tramite
  `userRowMarks` (`server/lib/user-row-marks.ts:51`) e la nuova kind entra in
  `MACHINE_ROW_KINDS` (`shared/prompt-number.ts:15`) e `MACHINE_KINDS`
  (`client/src/components/Chat/machineRow.ts:18`): il transcript la disegna come
  riga di servizio, non come un messaggio di Attilio.
- Si spedisce dalla route della chat nel processo, come la continuazione dei goal
  (`server/services/goal-continuation.ts:552-575`), **dopo** che
  `activeStreams` non ha più la sessione (la stessa attesa di
  `writeWhenTurnCloses`, `server/lib/background-notice.ts:186`); un 409
  `stream_in_flight` rimette in attesa, non perde.
- La topic si risolve per `topicId` al momento dell'invio: se nel frattempo il
  CLI è ripartito, il messaggio arriva lo stesso e la route riapre la sessione.
- **Una volta sola:** consegnato = esiste nella sessione una riga con il blocco
  `process-exit` di quel `processId`. Si controlla prima di spedire, e al boot
  per ogni comando finito con `wake` e senza quella riga.

Niente sveglia quando: `wake: false`; la topic è cancellata, o archiviata e
nessuna card in corso la possiede (l'esito resta nel pannello: la topic di un
agente della board nasce archiviata e riceve la sveglia finché la sua card è in
corso, la stessa regola delle sveglie del CLI in `server/lib/wake-adoption.ts`); il comando è stato fermato da Stop nel pannello o da
`stop_process`; un `wait_for_process` della stessa sessione era aperto su quel
processo quando è uscito (`watchesForProcess`, `server/lib/process-wait.ts:191`),
perché quel turno l'esito l'ha già.

Per il ciclo dei goal (`server/services/goal-loop.ts`) un comando che deve
ancora una sveglia alla sessione è lavoro in background come quello del CLI
(`backgroundOfTurn`): `running` finché gira, `wake-queued` quando è uscito e la
riga non è ancora in chat. Il turno che finisce su di lui aspetta invece di
essere giudicato e spinto avanti, e il turno della sveglia conta come notizia
(`woken`), cioè come progresso.

Lo stesso vale per il dispatcher della board (`server/services/task-dispatcher.ts`):
una card il cui agente chiude il turno su un comando che deve ancora una sveglia
alla sua sessione non riceve il sollecito e non consuma un tentativo. Aspetta
finché la sveglia è consegnata e il suo turno è finito, o il comando è fermato,
al massimo `BACKGROUND_WORK_CAP_MS` di sessione ferma (lo stesso tetto del
lavoro in background del CLI); poi prosegue come dopo ogni turno. Una sveglia che
la route rifiuta per sempre resta dovuta al boot successivo ma non si aspetta.

#### Scenario: l'esito arriva nella topic
- **GIVEN** un comando `zsh -c 'echo tick 1; echo tick 2; exit 3'` lanciato da una topic
- **WHEN** esce
- **THEN** la topic riceve una sola riga marcata `process-exit` che contiene `exit 3` e `tick 2`
- **AND** parte un turno dell'agente su quella riga

#### Scenario: un turno in volo non perde la sveglia
- **GIVEN** un turno in corso sulla topic quando il comando esce
- **WHEN** il turno si chiude
- **THEN** la riga `process-exit` arriva dopo, e nessuna richiesta finisce in un 409 perso

#### Scenario: il server muore fra l'uscita e la consegna
- **GIVEN** un comando uscito mentre la topic aveva un turno in volo, e il server che riparte prima della consegna
- **WHEN** il server torna su
- **THEN** la riga `process-exit` arriva una volta, e un secondo boot non la ripete

#### Scenario: l'agente stava già aspettando
- **GIVEN** un `wait_for_process` aperto sul comando nella sessione che l'ha lanciato
- **WHEN** il comando esce e l'attesa restituisce l'esito
- **THEN** nessuna riga `process-exit` viene scritta

#### Scenario: Stop dal pannello non sveglia
- **WHEN** l'utente ferma il comando dal pannello
- **THEN** la riga del pannello dice «fermato» e la topic non riceve messaggi

#### Scenario: un obiettivo attivo aspetta la sveglia
- **GIVEN** una topic con un goal attivo e un comando lanciato con `run_command` ancora in corso
- **WHEN** l'agente chiude il turno
- **THEN** il goal non giudica né manda continuazioni finché il comando gira
- **AND** a fine comando il turno della sveglia arriva come turno `woken` e viene giudicato

#### Scenario: una card della board aspetta la sveglia
- **GIVEN** una card in corso il cui agente ha lanciato un comando con `run_command`, sulla topic archiviata che il dispatcher gli ha creato
- **WHEN** l'agente chiude il turno mentre il comando gira
- **THEN** la card resta in corso, senza sollecito e senza consumare un tentativo
- **AND** a fine comando arriva la riga `process-exit`, e finito quel turno la card prosegue come dopo ogni turno

#### Scenario: topic archiviata
- **GIVEN** la topic archiviata mentre il comando girava, e nessuna card in corso che la possiede
- **WHEN** il comando esce
- **THEN** nessun messaggio, e l'esito resta nel pannello

### Requirement: BGSHELL-05 — Le shell in background del CLI attuale hanno l'id giusto e il log dal vivo

Il CLI attuale annuncia `Command running in background with ID: b68urh4wy.
Output is being written to: /…/b68urh4wy.output`. `parseBackgroundShellId`
(`server/providers/claude/background-shell.ts:77-93`) non tiene il punto finale
di una frase come parte dell'id. Il percorso dopo `Output is being written to:`
viaggia con l'azione `start` e il registro segue quel file in coda finché la
shell è viva, con lo stesso meccanismo di CMDRUN-03: il log non dipende più da un
`BashOutput` che il CLI non chiama (`TaskOutput` è mappato come controllo di
sotto-agente, `server/providers/claude/tool-detail.ts:275`).

Sola lettura: nessuna sveglia per le shell, che restano del CLI.

#### Scenario: l'id si legge senza il punto
- **WHEN** si analizza `Command running in background with ID: b68urh4wy. Output is being written to: /x/b68urh4wy.output`
- **THEN** l'id è `b68urh4wy` e il file è `/x/b68urh4wy.output`
- **AND** `Command running in background with ID: bash_1` dà ancora `bash_1`

#### Scenario: l'attesa trova la shell con l'id che l'agente vede
- **GIVEN** una shell registrata da quell'annuncio
- **WHEN** l'agente chiama `wait_for_process` con `b68urh4wy`
- **THEN** la route (`processes.ts:1854`) trova la riga invece di rispondere 404

#### Scenario: il log cresce senza che l'agente lo legga
- **GIVEN** una shell in background che scrive una riga al secondo nel suo file
- **WHEN** l'agente non chiama nessun tool di lettura
- **THEN** il log della riga nel pannello cresce comunque

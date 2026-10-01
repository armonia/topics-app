# processes Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: PROCESS-01 — Script Execution

The system SHALL provide script management capabilities including listing package.json scripts, starting scripts as background processes, stopping running processes, streaming live output with log persistence, detecting listening ports per process, and displaying script status with real-time WebSocket updates.

#### Scenario: Script runner loads scripts from package.json
- **GIVEN** a project sidebar is open for a topic with a linked project folder
- **WHEN** the ScriptRunner component mounts
- **THEN** the system SHALL fetch package.json scripts via the files API
- **AND** each script SHALL be displayed as a row with its name and a Play icon

#### Scenario: Script names are color-coded by category
- **GIVEN** scripts are loaded from package.json
- **WHEN** the script list renders
- **THEN** scripts matching "dev", "start", or "serve" SHALL have green icons
- **AND** scripts matching "build" or "compile" SHALL have blue icons
- **AND** scripts matching "test", "spec", or "e2e" SHALL have yellow icons
- **AND** scripts matching "lint", "format", or "prettier" SHALL have purple icons

#### Scenario: User starts a script
- **GIVEN** a script is listed and not currently running
- **WHEN** the user clicks on the script row
- **THEN** the system SHALL send a POST request to /api/scripts/run with projectPath and scriptName
- **AND** a spinning indicator SHALL appear next to the script name while starting

#### Scenario: Running script shows green pulse indicator
- **GIVEN** a script has been started and is currently running
- **WHEN** the script list renders
- **THEN** the script row SHALL display a green pulsing dot instead of the Play icon
- **AND** the script name SHALL appear in green bold text

#### Scenario: Running script displays listening ports
- **GIVEN** a script is running and has child processes listening on TCP ports
- **WHEN** the script list renders
- **THEN** the detected ports SHALL be displayed as clickable links (e.g., ":3000", ":5173")
- **AND** clicking a port link SHALL open the URL in a new browser tab

#### Scenario: User stops a running script
- **GIVEN** a script is currently running with a visible Stop button
- **WHEN** the user clicks the Square (stop) button on the script row
- **THEN** the system SHALL send a POST request to /api/scripts/:id/stop
- **AND** a red spinning indicator SHALL appear while the process is stopping
- **AND** the system SHALL poll until the process is confirmed stopped

#### Scenario: Server kills process with SIGTERM then SIGKILL fallback
- **GIVEN** a running script has been requested to stop
- **WHEN** the stop endpoint is called
- **THEN** the server SHALL send SIGTERM to the process group
- **AND** if the process is still alive after 5 seconds, SIGKILL SHALL be sent

#### Scenario: User clicks a running script to view its log
- **GIVEN** a script is currently running
- **WHEN** the user clicks on the script row (not the stop button)
- **THEN** the onOpenProcessLog callback SHALL be invoked with the processId and script name

#### Scenario: Script command tooltip displays on hover
- **GIVEN** a script is not currently running
- **WHEN** the user hovers over the script row
- **THEN** the full npm command SHALL appear as a tooltip and as truncated detail text

#### Scenario: Process list shows all sub-processes for a topic
- **GIVEN** a topic has spawned one or more agent sub-processes
- **WHEN** the ProcessList component mounts with the topicId
- **THEN** the system SHALL fetch processes from the processes API
- **AND** each process SHALL display with a status icon, label, and duration

#### Scenario: Process status icons indicate running, done, or error states
- **GIVEN** processes are loaded for a topic
- **WHEN** the process list renders
- **THEN** running processes SHALL show a spinning icon
- **AND** completed processes SHALL show a check icon
- **AND** errored processes SHALL show an error icon

#### Scenario: User expands a process to view details
- **GIVEN** the process list displays one or more processes
- **WHEN** the user clicks on a process row
- **THEN** the row SHALL expand to show the session key, start time, and completion time if available

#### Scenario: User stops a running agent process
- **GIVEN** a process is in the running state
- **WHEN** the user clicks the Square (stop) button on the process row
- **THEN** the system SHALL send a POST request to /api/agents/sessions/:key/stop
- **AND** the process list SHALL refresh after 1 second

#### Scenario: User spawns a new agent from the process list
- **GIVEN** the process list is visible
- **WHEN** the user clicks the Plus button in the header or the "Launch Agent" button
- **THEN** a spawn dialog SHALL appear with fields for Task (required), Label (optional), and Model (optional)

#### Scenario: Agent spawn dialog submits to the API
- **GIVEN** the spawn dialog is open with a task description entered
- **WHEN** the user clicks the Launch button
- **THEN** the system SHALL send a POST request to /api/agents/spawn with topicId, task, label, and model
- **AND** the dialog SHALL close and the process list SHALL refresh after 1 second

#### Scenario: Process list auto-refreshes every 10 seconds
- **GIVEN** the process list is mounted
- **WHEN** 10 seconds elapse since the last refresh
- **THEN** the system SHALL automatically fetch the latest process list

#### Scenario: Script output is streamed and persisted to log files
- **GIVEN** a script is running on the server
- **WHEN** the process writes to stdout or stderr
- **THEN** the output SHALL be captured in a circular buffer (max 500KB per process)
- **AND** the output SHALL be persisted to a log file in .state/scripts/

#### Scenario: Script output can be fetched with offset pagination
- **GIVEN** a script has produced output
- **WHEN** a GET request is sent to /api/scripts/:id/output with an offset parameter
- **THEN** the server SHALL return only lines after the specified offset
- **AND** the response SHALL include the current total offset, done status, and exit code

#### Scenario: Server broadcasts script state changes via WebSocket
- **GIVEN** a script starts, produces output, or completes
- **WHEN** the state changes
- **THEN** the server SHALL broadcast a "scripts:updated" event to all WebSocket clients
- **AND** output notifications SHALL be debounced to at most 1 per second

#### Scenario: Server re-adopts running processes after restart
- **GIVEN** scripts were running before a server restart
- **WHEN** the server starts and loads persisted state from .state/scripts.json
- **THEN** processes with PIDs still alive SHALL be re-tracked as running
- **AND** processes with dead PIDs SHALL be marked as error with exitCode -1

#### Scenario: Empty process list shows launch prompt
- **GIVEN** a topic has no sub-processes
- **WHEN** the process list renders
- **THEN** a "No sub-processes" message SHALL display with a "Launch Agent" button

#### Scenario: Script list returns empty when no package.json scripts exist
- **GIVEN** the project has no scripts in package.json
- **WHEN** the ScriptRunner component mounts
- **THEN** the component SHALL render nothing (return null)


### Requirement: BGSHELL-02 — A background shell of the agent is one row in the process registry

`Bash(run_in_background: true)` leaves a process behind, and its only trace used to be the card in the transcript — a memory, not a state: it scrolled away, it was not counted, and it could not be killed. Such a shell SHALL be registered as a live process alongside Topics' own scripts (`PROCESS-01`), and SHALL stay ONE row through re-announcement, output and exit.

> This is NOT `PROCESS-01`: that is Topics' own `package.json` script runner. Companions in `chat`: `BGSHELL-01` (reading the CLI's answer) and `BGSHELL-03` (the live card).

#### Scenario: A started shell becomes a running process row
- **GIVEN** a background shell announced with its session key, topic, id, command and working directory
- **WHEN** it is registered
- **THEN** a running row SHALL exist carrying the command, a shortened label and the topic
- **AND** its pid SHALL be null until the process is located in the tree — a row without a pid still being worth more than no row

#### Scenario: Re-announcing the same shell does not wipe its output
- **GIVEN** a registered shell with output already recorded
- **WHEN** the same shell is registered again, as after a re-attach
- **THEN** the recorded output SHALL still be there and the row SHALL still be running

#### Scenario: Output is appended without closing the shell
- **GIVEN** a running registered shell
- **WHEN** an output report arrives with status running
- **THEN** the new output SHALL be appended and the row SHALL stay running

#### Scenario: A terminal status carries the shell to its outcome
- **GIVEN** a running registered shell
- **WHEN** a completed status with exit code 0 arrives
- **THEN** the row SHALL move to done carrying that exit code
- **AND** a failed status with a non-zero code SHALL move it to error carrying that code, a failure never reading as a conclusion

#### Scenario: A killed shell is closed as terminated
- **GIVEN** a running registered shell
- **WHEN** it is closed as killed
- **THEN** the row SHALL move to error and its log SHALL say it was terminated

#### Scenario: An outcome already recorded is not rewritten
- **GIVEN** a shell already closed as completed with exit code 0
- **WHEN** it is closed a second time, as killed
- **THEN** the first outcome SHALL stand

#### Scenario: An unknown id invents nothing
- **GIVEN** an id that was never registered
- **WHEN** output is reported for it, or it is closed
- **THEN** no row SHALL come into existence

#### Scenario: The broadcast snapshot carries the keys the card looks a shell up by
- **GIVEN** a registered background shell
- **WHEN** the scripts snapshot is built — the frame that arrives FIRST, the HTTP poll being up to fifteen seconds behind
- **THEN** the row SHALL be keyed by its process key and SHALL carry the shell id, the topic and the source `shell`
- **AND** a finished shell SHALL stay in the snapshot with its status and exit code
- **AND** a process that is not a shell SHALL carry no shell id

#### Scenario: The process key is composed identically on both sides
- **GIVEN** a session key and a shell id, the one written by the server and the one recomposed by the card
- **WHEN** the process key is built
- **THEN** it SHALL combine both parts, sanitised of the characters a process id cannot hold
- **AND** two different sessions using the SAME shell id SHALL produce different keys

#### Scenario: The registry's own log header is not shown twice
- **GIVEN** a shell log opening with the registry's header line, which exists to give the process row a content before the agent reads anything
- **WHEN** the log is prepared for the chat card, where the id is already written above it
- **THEN** the header SHALL be stripped when the log starts with it, a header-only log becoming empty
- **AND** a log that does not start with it, or that starts with ANOTHER shell's header, SHALL be left untouched

### Requirement: BGSHELL-04 — The orphans of a dead background shell are swept

When a background shell dies — the CLI exits, the shell takes a SIGTERM — the children it spawned do NOT die with it: they are re-parented, holding ports and memory, with no Stop button attached to them any more. The process tree is already broken by then, so the system SHALL capture the shell's subtree WHILE IT IS ALIVE and use that snapshot as the only remaining handle.

#### Scenario: The subtree captured alive closes the survivors
- **GIVEN** a shell that left two children running in the background
- **WHEN** its subtree is captured while alive, the shell is then killed, and the sweep runs
- **THEN** the surviving children SHALL be closed

#### Scenario: A recycled pid is not touched
- **GIVEN** a captured pid that the operating system has since reassigned to another process
- **WHEN** the sweep runs
- **THEN** that process SHALL be left alone: the start time has to match, not just the number

#### Scenario: How a shell that is gone is recorded
- **GIVEN** a running shell row being reconciled against the machine
- **WHEN** its own process is gone
- **THEN** the outcome SHALL be completed, however the parent fared
- **AND** when only the owning CLI is gone while the shell was still running, the outcome SHALL be killed — it was interrupted
- **AND** when neither is gone, nothing SHALL be closed

### Requirement: SUBAGENT-03 — The sub-agent process panel tells the truth about what is running

`GET /api/processes` is the only view Topics has of sub-agents AS PROCESSES. It SHALL list first the chat's own `run_command` processes, running and recent, with their ports (BGVIS-08 in `chat/spec.md`): a chat that showed a server answered `[]` there. The mapping from a provider's session list SHALL keep only the sub-agents, SHALL treat `active` as the only status meaning running, and SHALL carry a completion time only for what has finished.

#### Scenario: Only sub-agents reach the panel
- **GIVEN** a provider session list holding sub-agent sessions, a topic session and a terminal session
- **WHEN** the panel's processes are derived
- **THEN** only the sessions whose key names them sub-agents SHALL be kept, in order — widening this fills the panel with every session the provider knows, presented as running under the chat
- **AND** an entry with no session key SHALL be skipped without raising
- **AND** an empty list SHALL yield an empty panel, not an error

#### Scenario: Running means active, and nothing else
- **GIVEN** a session whose status is `active`
- **WHEN** it is mapped
- **THEN** it SHALL be running, and SHALL carry no completion time
- **AND** any other status — done, exited, failed, unknown, empty or absent — SHALL be done and SHALL carry a completion time, so an unfamiliar status never leaves a spinner turning forever

#### Scenario: A readable label and an honest clock
- **GIVEN** a sub-agent session with no label of its own
- **WHEN** it is mapped
- **THEN** the label SHALL be the LAST segment of its key, never the whole key and never an empty string
- **AND** a real label SHALL win over that fallback
- **AND** a missing start time, or a missing end time on a finished process, SHALL fall back to the current time rather than to an empty string

### Requirement: PROCESS-10 — Il rilevamento rallenta quando non cambia niente, e riparte a piena cadenza al primo cambiamento

Ogni passata di rilevamento dei processi lancia più comandi di sistema. A cadenza
FISSA sono decine di migliaia di avvii al giorno per riscoprire lo STESSO elenco,
anche quando nessuno sta guardando il pannello.

Senza cambiamenti l'intervallo SHALL RADDOPPIARE, fermandosi a un TETTO. Un
cambiamento SHALL riportare SEMPRE alla cadenza piena.

Il risparmio a riposo SHALL essere MISURATO, non dichiarato.

#### Scenario: niente cambia
- **GIVEN** più passate consecutive identiche
- **THEN** l'intervallo SHALL raddoppiare fino al tetto

#### Scenario: qualcosa cambia
- **GIVEN** un cambiamento nell'elenco
- **THEN** l'intervallo SHALL tornare a quello pieno

### Requirement: PROCESS-11 — Uno script FANTASMA è quello che gira su una copia di lavoro CANCELLATA

Uno script SHALL essere dichiarato FANTASMA quando gira su una copia di lavoro che
NON esiste più. Una copia VIVA — anche se la cartella di lavoro è la sua radice —
NON SHALL produrre un fantasma, e nemmeno una cartella che non è una copia di
lavoro nostra.

Uno script che NON è nostro, uno già CONCLUSO, e uno di cui non si conosce il
processo NON SHALL essere dichiarato fantasma: senza identificativo non lo si può
riconoscere.

I percorsi SHALL essere CANONICALIZZATI prima del confronto, o un collegamento
simbolico fa sembrare cancellata una copia viva.

Una cartella di lavoro che sta SOTTO la base ma dentro la radice di un'ALTRA copia
viva SHALL essere un fantasma: quella copia non è la sua.

#### Scenario: un collegamento simbolico nel percorso
- **GIVEN** una copia viva raggiunta per un percorso alternativo
- **THEN** NON SHALL essere dichiarata fantasma

#### Scenario: uno script già concluso
- **GIVEN** un processo non più in esecuzione
- **THEN** NON SHALL essere dichiarato fantasma

### Requirement: PROCESS-12 — Chiudere un'anteprima libera la PORTA, non solo il processo che l'ha avviata

Chiudere un'anteprima SHALL liberare davvero la PORTA. Il comando di
un'anteprima è un LANCIATORE: chi ascolta è un suo DISCENDENTE. Mandando il
segnale al solo processo avviato, il lanciatore muore e il server no — la porta
resta occupata, e con un numero limitato di porte bastano poche consegne per
lasciare una card in review senza evidenza.

La pulizia all'AVVIO SHALL chiudere un'anteprima rimasta da un server morto, e NON
SHALL toccare chi ascolta da una cartella che NON è una copia di lavoro nostra.

Il banco SHALL usare un processo che ascolta DAVVERO — non una finzione — e SHALL
prendere una porta LIBERA invece di una fissa: una porta fissa rende il banco
verde da solo e rosso in parallelo.

#### Scenario: un lanciatore con un discendente in ascolto
- **GIVEN** la chiusura dell'anteprima
- **THEN** la porta SHALL essere libera

#### Scenario: un server di terzi sulla stessa porta
- **GIVEN** un ascoltatore da una cartella estranea
- **THEN** NON SHALL essere toccato

### Requirement: BRIDGE-OWN-01 — Un proprietario VIVO ma lento non si sfratta

Il 13/08/2026 questo contratto è costato la macchina due volte in un'ora, una
volta perfino attraverso un riavvio: 1612 processi sullo stesso socket in dodici
minuti, 3653 processi in tutto, 36 GB di scambio su una macchina da 32, carico
644, e il server principale irraggiungibile. La causa era una riga di giudizio:
scambiare «non ha risposto in tempo» per «non c'è nessuno».

Un proprietario VIVO che è soltanto TROPPO LENTO a rispondere NON SHALL essere
sfrattato: la lentezza non è assenza, e sfrattarlo mette due processi sullo
stesso socket — che è come nasce la moltiplicazione.

Un socket ABBANDONATO, senza nessuno in ascolto, SHALL poter essere preso.

Più processi in corsa per un socket LIBERO SHALL lasciarne esattamente UNO in
ascolto.

#### Scenario: un proprietario lento
- **GIVEN** un processo vivo che non risponde entro la finestra
- **THEN** NON SHALL essere sfrattato

#### Scenario: cinque in corsa sullo stesso socket libero
- **GIVEN** più candidati simultanei
- **THEN** esattamente uno SHALL restare in ascolto

### Requirement: BRIDGE-01 — Il ponte consegna per OFFSET, e riattaccarsi non perde né duplica

La scrittura SHALL tornare come dati indirizzati per POSIZIONE, e un
riattaccamento SHALL rigiocare la storia SENZA PERDITE.

L'accensione SHALL essere IDEMPOTENTE per identificativo: MAI un secondo figlio
sulla stessa trascrizione. Riaccendere su una sessione VIVA SHALL attaccare chi
chiama al flusso vivo, non ricominciare.

L'elenco SHALL riportare la sessione, e la chiusura SHALL toglierla.

Il segnale di uscita SHALL scattare quando il figlio finisce, e un attaccamento
TARDIVO SHALL comunque rigiocare l'output completato: chi arriva dopo non ha
diritto a meno storia.

Uno store grande SHALL arrivare in PIÙ pezzi, CONTIGUI e identici byte per byte.
Un attaccamento dalla coda ESATTA NON SHALL consegnare nemmeno un byte.

Un processo il cui padre dichiarato è MORTO SHALL ritirarsi appena nessun client
è connesso. Una SONDA che si connette e chiude NON SHALL rinnovare la licenza a
restare vivo — è il modo in cui un orfano si tiene in vita da solo. Con un padre
VIVO SHALL restare su.

#### Scenario: un attaccamento tardivo
- **GIVEN** un figlio già terminato
- **THEN** l'output completato SHALL essere rigiocato per intero

#### Scenario: una sonda che si connette e chiude
- **GIVEN** un processo orfano e una connessione istantanea
- **THEN** NON SHALL essere rinnovata la sua licenza a restare vivo

### Requirement: PTYORPH-01 — Il ponte del terminale sa RITIRARSI, e non solo quando il padre muore

Misurato il 14/08/2026: venti ponti vivi con ZERO client e ZERO sessioni figlie,
fino a trentasette ore d'età, quindici dei quali puntavano a copie di lavoro già
cancellate — circa 365 MB fermi lì. NESSUNO aveva mai scritto nel proprio
registro che il padre era morto: il sorvegliante anti-orfano non scattava.

Un ponte il cui padre dichiarato è MORTO SHALL ritirarsi, e SHALL portarsi via il
proprio socket: un socket rimasto lì fa credere al successivo che qualcuno
ascolti.

Una SONDA che si connette e chiude NON SHALL rinnovare la licenza. Con il padre
VIVO SHALL restare su.

Alla scadenza con qualcuno attaccato da poco SHALL esserci UNA proroga, lunga
quanto serve a un server appena riagganciato per contare come tale: la soglia
del client vero più un tick del monitor, non il doppio della soglia. Oltre
quello la proroga non compra niente, e il suo costo si paga a ogni corsa del
test: con il doppio il ritiro impiegava ~7,9 s contro un budget di 8, e sotto
carico (23 su 12 core) sforava (card 16d07948); con soglia più tick impiega
~5,5 s.

**E SHALL esserci un secondo freno, indipendente dal padre**: senza client e
senza sessioni figlie SHALL ritirarsi ANCHE con il padre vivo — è il caso dei
quindici che puntavano al nulla. Con un client attaccato NON SHALL ritirarsi: il
freno non uccide chi è in uso.

#### Scenario: nessun client, nessuna sessione, padre vivo
- **GIVEN** un ponte inutilizzato da tempo
- **THEN** SHALL ritirarsi lo stesso

#### Scenario: un client attaccato
- **GIVEN** almeno un client vivo
- **THEN** NON SHALL ritirarsi

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
all'agente niente che il suo `Bash` non abbia già. E non gli toglie il recinto
che quel `Bash` ha: quando la sessione è quella di una card della board, il
comando riceve la stessa quota di core (`applyJobQuota`,
`server/services/agent-job-quota.ts`: `CARGO_BUILD_JOBS`, `MAKEFLAGS` e gli
shim di `cargo`/`make` che rileggono il numero vivo); una chat non ne riceve.

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

#### Scenario: il comando di una card ha la quota di core del suo Bash
- **GIVEN** la sessione di una card in corso
- **WHEN** l'agente lancia `run_command` con `echo "jobs=$CARGO_BUILD_JOBS make=$MAKEFLAGS"`
- **THEN** il log stampa `jobs=N make=-jN`, la quota che riceve il `Bash` della stessa sessione
- **AND** lo stesso comando da una chat stampa `jobs= make=`

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
perché quel turno l'esito l'ha già. Lo stesso quando il comando esce senza
un'attesa aperta (fra una risposta `timeout` e la chiamata dopo, o mentre
l'agente fa altro) e lo stesso turno ne legge la fine: un `wait_for_process`
che risponde `exit`, o `match` su righe finali con stato e codice di un
processo finito (la risposta allora dice `finished · status=… exit=N`, non
«still»), oppure un `read_process_output` che risponde `done`. La sveglia si
chiude lì, se la sua riga non è ancora partita: dentro il turno della sveglia
stessa si chiude alla fine di quel turno, come sempre.
L'attesa conta solo finché il turno che l'ha
aperta è in corso: finito il turno (`endStream`), non conta più anche se la sua
richiesta resta aperta, perché il bridge di un CLI ignora l'annullamento di una
tool call. Sul runtime nativo la richiesta si chiude con il turno, e un turno
fermato dentro `wait_for_process` finisce subito invece di aspettare la risposta
della rotta.

Per il ciclo dei goal (`server/services/goal-loop.ts`) un comando che deve
ancora una sveglia alla sessione è lavoro in background come quello del CLI
(`backgroundOfTurn`): `running` finché gira, `wake-queued` da quando è uscito
finché il turno aperto dalla sua riga non è finito, che quel turno occupi o no
`activeStreams`. Il turno è finito quando il suo stream si chiude, o quando la
sessione è libera da 20 s e lo stream tace ancora (la stessa grazia del lettore
headless, per lo stesso stream che una volta non si è chiuso). Il turno che
finisce su di lui aspetta invece di essere giudicato e spinto avanti; il turno della sveglia non aspetta sé stesso e conta
come notizia (`woken`), cioè come progresso.

Lo stesso vale per il dispatcher della board (`server/services/task-dispatcher.ts`):
una card il cui agente chiude il turno su un comando che deve ancora una sveglia
alla sua sessione non riceve il sollecito e non consuma un tentativo. Aspetta
finché la sveglia è consegnata e il suo turno è finito, o il comando è fermato,
al massimo `BACKGROUND_WORK_CAP_MS` di sessione ferma (lo stesso tetto del
lavoro in background del CLI); poi prosegue come dopo ogni turno. Una sveglia che
la route rifiuta per sempre resta dovuta al boot successivo ma non si aspetta.

L'attesa vive in memoria e un riavvio del server la ricrea, ma il suo silenzio
parte dall'ultima riga della sessione nella tabella `messages`, non dal boot:
su questa macchina il server si ricarica a ogni salvataggio in `server/`, e un
tetto che ripartisse a ogni boot non scatterebbe mai. Al boot l'attesa viene
dopo l'interruttore del dispatch (una card trattenuta a dispatch spento resta
trattenuta) e dopo la sonda del broker (un turno sopravvissuto in ai-bridge si
riaggancia e, quando finisce, aspetta la sveglia come ogni turno). I token del
turno della sveglia vanno sul conto della card anche con un riavvio in mezzo.

Il turno di un agente della board è giudicato quando finisce, e un tentativo di
fan-out è un turno solo. Per questo il kickoff (normale e di fan-out), il prompt
di sistema di una sessione dispatchata e `run_command` nei profili `dispatch` e
`codex-dispatch` (descrizione e risultato) gli dicono di lanciare i comandi
lunghi con `run_command` (`run_script` per uno script dichiarato, e solo quello
dove `run_command` non c'è) e di prenderne l'esito con `wait_for_process` nello
stesso turno, mai di chiuderlo con un comando in corso. Non sono comandi da
aspettare un dev server lasciato acceso per la tab del revisore, che resta acceso
dopo il turno (con `run_command` parte con `wake: false`), e l'attesa di una
condizione esterna (un servizio che torna, una finestra oraria, un retry ogni
tanto), che si dichiara con `wait_for_condition` come dice il kickoff. Il prompt
di sistema della board non gli consiglia nemmeno di chiudere il turno su un `Monitor` o su
una shell in background, perché la rete copre solo la sveglia di `run_command`;
su Windows dice la stessa regola con `run_script`. È dispatchata ogni sessione
legata a una card, compresi i tentativi di fan-out dal 2 in poi. Con
`dispatch_mcp='inherit'` il bridge non ha il profilo `dispatch` e `run_command`
parla come nelle chat: restano il kickoff e il prompt di sistema. Il flusso
«chiudi il turno, la sveglia ti riporta» resta alle chat normali; l'attesa del
dispatcher qui sopra è la rete per l'agente che chiude il turno lo stesso.

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

#### Scenario: il comando esce fra due attese dello stesso turno
- **GIVEN** un turno in corso sulla topic e il suo comando che esce mentre nessun `wait_for_process` è aperto
- **WHEN** il `wait_for_process` successivo dello stesso turno restituisce l'esito
- **THEN** finito il turno non arriva nessuna riga `process-exit`, e nessuna card aspetta una sveglia

#### Scenario: la fine letta con `until` o con `read_process_output`
- **GIVEN** un turno in corso sulla topic e il suo comando uscito mentre nessun `wait_for_process` è aperto
- **WHEN** lo stesso turno chiama `wait_for_process` con un `until` che combacia con le righe finali (risposta `match` con stato e codice), oppure `read_process_output` (risposta `done`)
- **THEN** finito il turno non arriva nessuna riga `process-exit`, e nessuna card aspetta una sveglia

#### Scenario: il turno della sveglia rilegge l'esito
- **GIVEN** la riga `process-exit` del comando consegnata, e il turno che ha aperto in corso
- **WHEN** in quel turno l'agente chiama `wait_for_process` o `read_process_output` sullo stesso comando
- **THEN** la sveglia resta in coda fino alla fine di quel turno, e una card continua ad aspettarlo

#### Scenario: il turno che aspettava è finito
- **GIVEN** un `wait_for_process` aperto sul comando da un turno della stessa sessione
- **WHEN** quel turno finisce (fermato, sostituito) con la richiesta ancora aperta, e poi il comando esce
- **THEN** la topic riceve la riga `process-exit`
- **AND** sul runtime nativo il turno fermato esce subito dall'attesa e ne chiude la richiesta

#### Scenario: lo stream del turno della sveglia non si chiude
- **GIVEN** il turno aperto dalla sveglia finito, e il suo stream ancora aperto
- **WHEN** la sessione resta libera per la grazia
- **THEN** la sveglia è chiusa come consegnata e non tiene più il goal né la card

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

#### Scenario: la sveglia parte mentre la card chiude il suo turno
- **GIVEN** una card il cui agente lancia un comando che finisce prima che il turno di lancio si chiuda
- **WHEN** la riga della sveglia entra in chat mentre il dispatcher legge ancora la statistica git di quel turno
- **THEN** la card aspetta il turno della sveglia, senza sollecito e senza consumare un tentativo

#### Scenario: l'agente della board aspetta dentro il turno
- **GIVEN** una card dispatchata su un sistema che offre `run_command`
- **WHEN** l'agente legge il kickoff, il prompt di sistema e lo strumento `run_command`
- **THEN** ognuno gli dice di prendere l'esito con `wait_for_process` nello stesso turno e di non chiuderlo mentre il comando gira
- **AND** nessuno gli dice di lanciarlo con `&` né che può chiudere il turno e aspettare la sveglia

#### Scenario: nessuna attesa della board chiude il turno
- **GIVEN** il prompt di sistema di una sessione dispatchata, su macOS e su Windows, anche per il tentativo 2 di un fan-out
- **WHEN** l'agente cerca come aspettare una build lunga
- **THEN** il prompt gli dice di aspettarla con `wait_for_process` nello stesso turno
- **AND** nessuna frase gli consiglia di chiudere il turno su un `Monitor`, su una shell in background o su una sveglia

#### Scenario: un server per la tab e un'attesa esterna non si aspettano nel turno
- **GIVEN** il kickoff e il prompt di sistema di una sessione dispatchata
- **WHEN** l'agente lascia acceso un dev server per la tab del revisore, o deve aspettare un servizio per ore
- **THEN** il server non è fra i comandi da aspettare e resta acceso dopo il turno
- **AND** l'attesa esterna si dichiara con `wait_for_condition`, e nessuna frase gli dice di aspettare un ciclo di retry dentro il turno

#### Scenario: l'attesa di una card regge ai riavvii
- **GIVEN** una card che aspetta la sveglia di un comando che non finisce mai
- **WHEN** il server riparte ogni 90 minuti
- **THEN** dopo `BACKGROUND_WORK_CAP_MS` dall'ultima riga della sessione la card prosegue come dopo ogni turno

#### Scenario: un turno sopravvissuto nel broker si riaggancia
- **GIVEN** una card con un comando che deve la sveglia, e il suo turno ancora vivo in ai-bridge al boot
- **WHEN** il server torna su
- **THEN** il turno si riaggancia invece di restare senza lettore
- **AND** quando finisce la card aspetta la sveglia, senza sollecito né tentativo

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

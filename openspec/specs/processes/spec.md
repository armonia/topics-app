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

`GET /api/processes` is the only view Topics has of sub-agents AS PROCESSES. The mapping from a provider's session list SHALL keep only the sub-agents, SHALL treat `active` as the only status meaning running, and SHALL carry a completion time only for what has finished.

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

## Purpose

Specifies behavioral scenarios for the embedded terminal emulator including session lifecycle, xterm.js rendering, WebSocket connectivity, multi-instance management, and auto-reconnect behavior.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic exists with a linked project folder
- The terminal pane is available via the add-pane menu in the project sidebar

## Requirements

### Requirement: TERM-01 — Session Lifecycle, Rendering & Connection

The system SHALL support opening terminal sessions with xterm.js rendering, WebSocket-backed communication, keyboard input/output, multi-instance tab management, auto-reconnect after disconnection, and pane resize handling.

#### Scenario: Terminal opens and renders in the pane
- **GIVEN** a topic with a linked project folder is selected
- **WHEN** the user opens a terminal via the add-to-project menu and selects Shell
- **THEN** a terminal emulator renders in the pane with visible text rows
- **AND** a terminal tab appears in the pane tab bar

#### Scenario: Terminal establishes WebSocket connection on open
- **GIVEN** the user opens a new terminal session
- **WHEN** the terminal pane renders
- **THEN** a WebSocket connection is established to the server for the terminal session
- **AND** the shell prompt appears indicating the session is ready

#### Scenario: Terminal accepts keyboard input and displays output
- **GIVEN** a terminal session is open and the shell prompt is visible
- **WHEN** the user clicks the terminal to focus it and types a command
- **THEN** the typed characters appear in the terminal
- **AND** pressing Enter executes the command and displays the output

#### Scenario: Terminal opens with the correct project working directory
- **GIVEN** a topic is linked to a specific project folder
- **WHEN** the user opens a terminal session for that topic
- **THEN** the terminal shell starts in the linked project folder as the working directory

#### Scenario: Terminal auto-reconnects after WebSocket disconnect
- **GIVEN** a terminal session is active with a working WebSocket connection
- **WHEN** the WebSocket connection is unexpectedly closed
- **THEN** the terminal client automatically attempts to reconnect
- **AND** a new WebSocket connection is established to the server

#### Scenario: Terminal resumes command execution after reconnect
- **GIVEN** a terminal session has auto-reconnected after a WebSocket disconnect
- **WHEN** the user types a command in the reconnected terminal
- **THEN** the command executes successfully
- **AND** the output is displayed in the terminal

> Note: The PTY process on the server survives WebSocket disconnects. Only the WebSocket transport link is interrupted during reconnection.

#### Scenario: Multiple terminal instances can be opened simultaneously
- **GIVEN** a terminal session is already open in a pane
- **WHEN** the user opens another terminal via the add-to-project menu
- **THEN** a second terminal session opens in a new tab
- **AND** both terminal tabs are visible in the pane tab bar

#### Scenario: Switching between terminal tabs shows correct session
- **GIVEN** two terminal sessions are open with different command histories
- **WHEN** the user clicks the first terminal tab
- **THEN** the first terminal's content and command history is displayed
- **AND** clicking the second terminal tab shows the second terminal's content

#### Scenario: Each terminal instance maintains independent session state
- **GIVEN** two terminal sessions are open
- **WHEN** the user runs a command in the first terminal
- **THEN** the command output appears only in the first terminal
- **AND** the second terminal remains unaffected with its own session state

#### Scenario: Terminal resizes when pane dimensions change
- **GIVEN** a terminal session is open in a pane
- **WHEN** the user resizes the pane by dragging a divider
- **THEN** the terminal adjusts its column and row count to fit the new dimensions
- **AND** text wrapping updates accordingly

> Note: Terminal resize behavior relies on xterm.js fit addon and server-side PTY resize signaling via WebSocket.

#### Scenario: Terminal preserves scrollback buffer content
- **GIVEN** a terminal session has produced enough output to fill the visible area
- **WHEN** the user scrolls up in the terminal
- **THEN** previously rendered output is visible in the scrollback buffer

#### Scenario: New terminal tab via add-pane menu creates fresh session
- **GIVEN** a terminal session already exists in the current pane group
- **WHEN** the user opens a new terminal via the add-to-project menu
- **THEN** a new independent terminal session is created
- **AND** the new session starts with a fresh shell prompt

#### Scenario: Closing terminal tab terminates the session
- **GIVEN** a terminal session is open in a tab
- **WHEN** the user closes the terminal tab
- **THEN** the terminal session is terminated on the server
- **AND** the tab is removed from the pane tab bar

> Note: Session cleanup relies on the server receiving a close signal. Abrupt browser closure may leave orphan sessions until server-side timeout.

#### Scenario: Terminal handles rapid input without dropping characters
- **GIVEN** a terminal session is open and focused
- **WHEN** the user types a long command rapidly
- **THEN** all typed characters appear in the terminal without being dropped or reordered

#### Scenario: Terminal focus is activated by clicking the terminal area
- **GIVEN** a terminal session is open but not focused
- **WHEN** the user clicks on the terminal rendering area
- **THEN** the terminal receives keyboard focus
- **AND** subsequent keystrokes are sent to the terminal session

#### Scenario: Terminal displays colored output correctly
- **GIVEN** a terminal session is open
- **WHEN** a command produces ANSI color-coded output
- **THEN** the terminal renders the output with the appropriate colors

#### Scenario: Terminal reconnection uses exponential backoff
- **GIVEN** a terminal session has lost its WebSocket connection
- **WHEN** the client attempts to auto-reconnect
- **THEN** reconnection attempts use exponential backoff timing
- **AND** the client makes up to a maximum number of retry attempts before giving up

> Note: The implementation uses up to 15 retry attempts with exponential backoff. Limited direct test coverage for the full backoff sequence.

### Requirement: TERM-02 — Reload (Restart) a Terminal Session In Place

The system SHALL let a user restart a live terminal session **in place** from the
tab's right-click context menu, preserving the tab's identity (the pane id
`terminal:<sessionId>` is unchanged). For `claude-code`, `claude-code-team`, and
`codex` sessions that have a recorded `claude_session_id`, the restart SHALL
relaunch the CLI with `--resume` so the conversation is preserved; for `shell`
sessions it SHALL start a fresh PTY in the same working directory.

The restart SHALL be exposed as a server endpoint `POST
/api/terminal/sessions/:id/reload` that: captures the session's record before
killing it, sends a `kill` to the bridge, waits (bounded) for the PTY to exit, then
recreates the session with the **same** session id via the existing
`createSession` path. The endpoint SHALL be idempotent if the PTY is already dead
(it just recreates) and SHALL return `404` only when no session exists either live
or in the database.

The "Ricarica" menu item SHALL appear **only** for terminal panes (pane id
starting with `terminal:`) and SHALL NOT appear for chat, browser, or other pane
types.

#### Scenario: Reload a wedged Claude session preserves the conversation

- **GIVEN** a `claude-code` terminal session that is stuck (e.g. showing
  `Not logged in · Run /login`) and has a recorded `claude_session_id`
- **WHEN** the user right-clicks its tab and selects "Ricarica"
- **THEN** the server kills the old PTY, waits for it to exit, and relaunches
  `claude --resume <claude_session_id>` with the same session id
- **AND** the tab keeps the same pane id `terminal:<sessionId>` (it does not close
  and reopen)
- **AND** the resumed conversation is available and the stuck banner is gone

#### Scenario: Reload a shell session restarts the PTY in the same cwd

- **GIVEN** a `shell` terminal session running in a project folder
- **WHEN** the user right-clicks its tab and selects "Ricarica"
- **THEN** a fresh PTY is started in the same working directory under the same
  session id
- **AND** no `--resume` is used (shell state is not resumable)

#### Scenario: "Ricarica" is shown only for terminal tabs

- **GIVEN** a tab bar containing a chat tab, a browser tab, and a terminal tab
- **WHEN** the user opens the right-click context menu on each
- **THEN** the "Ricarica" item appears only on the terminal tab's menu

#### Scenario: Reload is idempotent when the PTY is already dead

- **GIVEN** a terminal session whose PTY has already exited (dormant or removed)
- **WHEN** `POST /api/terminal/sessions/:id/reload` is called
- **THEN** the session is recreated with the same id without error
- **AND** the response reports the active session

#### Scenario: Reload of a non-existent session returns 404

- **GIVEN** a session id that exists neither in the live session map nor in the
  database
- **WHEN** `POST /api/terminal/sessions/:id/reload` is called
- **THEN** the server responds `404`

### Requirement: TERM-03 — A Bridge That Fails To Start SHALL Say Why

Every terminal session is served by a PTY bridge process. When the server cannot
reach it, the thrown error SHALL name the cause it actually observed, and SHALL
distinguish the cases that send an investigator to different places:

1. the **spawn failed** — the bridge was never born (`ENOENT` when the command is
   not on PATH, `EACCES` when it is there without an exec bit);
2. the **bridge spoke** — it started, wrote a reason to its stderr log, and died;
3. the **log could not be opened** — the bridge's stderr was routed to `'ignore'`,
   so any reason it gave was discarded before anyone could read it;
4. **nothing to go on** — it started, wrote nothing, and disappeared.

Cases 1 and 3 SHALL NOT be reported using the words of case 4. The bridge's stderr
log is append-only and outlives the process that wrote it, so a spawn failure
SHALL take precedence over a line left in the log by a previous bridge.

The server SHALL register an `error` listener on the spawned child. A `detached`
child that is `unref`'d still emits `error` on the parent's handle, and without a
listener that event has no recipient.

A spawn that has already failed SHALL NOT continue to be polled for the remainder
of the connect timeout.

> Note: case 1 is not hypothetical. `EACCES` here is node-pty's `spawn-helper`
> without its exec bit — the same fault that `scripts/fix-node-pty-exec-bit.ts`
> exists to repair, and that previously cost a full investigation because the
> error named none of this.

#### Scenario: The bridge binary is missing and the error names the spawn

- **GIVEN** the configured bridge command does not exist on PATH
- **WHEN** the server tries to open a terminal session
- **THEN** the error states that the spawn failed and includes the errno
- **AND** it does not claim that the bridge left no log

#### Scenario: The bridge died and its last words are carried through

- **GIVEN** the bridge started and wrote `Self-test failed: posix_spawnp failed.`
  to its stderr log before exiting
- **WHEN** the server gives up waiting for the socket
- **THEN** the error carries that line verbatim

#### Scenario: A stale log line does not explain a fresh spawn failure

- **GIVEN** a bridge log that already contains the last words of an earlier bridge
- **AND** a spawn that fails with `EACCES`
- **WHEN** the server reports the failure
- **THEN** the error names the `EACCES`
- **AND** it does not quote the earlier bridge's line

#### Scenario: A discarded stderr is admitted rather than reported as silence

- **GIVEN** the bridge's stderr log cannot be opened for writing
- **WHEN** the bridge fails to come up
- **THEN** the error states that the log could not be opened, names the reason,
  and says the bridge's stderr was discarded

### Requirement: TERM-04 — I terminali fermi si PARCHEGGIANO, e in mancanza di dati non si parcheggia

Un terminale di agente fermo SHALL poter essere PARCHEGGIATO, non ucciso: lo
stato di quella sessione sta su disco ed è ciò che la ripresa rilegge, quindi
spegnere il processo e marcare la riga dormiente non perde niente.

Serviva perché quel sottosistema non aveva né un raccoglitore di inattività né un
tetto di vita: misurate il 02/08/2026, tredici sessioni vive da **tre giorni e
cinque ore**, circa il 15% di una macchina e 0,9 GB per stare ferme a un prompt.

**In mancanza di dati NON si parcheggia.** Un valore assente, un campo mancante,
una fase sconosciuta SHALL valere tutti «no». L'errore di non parcheggiare costa
un po' di memoria; l'errore opposto uccide lavoro vivo, e un raccoglitore su
questo sottosistema l'ha già fatto una volta.

NON SHALL essere parcheggiato: un terminale il cui scrollback È il suo stato,
perché non ha una ripresa da cui ripartire; una sessione senza identificativo di
ripresa; una sessione il cui trascritto NON esiste su disco, perché la ripresa
fallirebbe PER SEMPRE; una sessione la cui uscita CANCELLA la riga invece di
renderla dormiente.

NON SHALL essere parcheggiata una sessione con la pseudo-terminale che sta
scrivendo ADESSO, né una in un turno in corso, né una con un client attaccato —
uno o più, l'esito è lo stesso.

Una sessione ferma ad ASPETTARE UNA PERSONA SHALL invece poter essere
parcheggiata: è ferma davvero.

La soglia SHALL avere un confine verificato da entrambi i lati.

#### Scenario: trascritto assente
- **GIVEN** una sessione senza il proprio trascritto su disco
- **THEN** NON SHALL essere parcheggiata

#### Scenario: qualcuno sta guardando
- **GIVEN** un client attaccato alla sessione
- **THEN** NON SHALL essere parcheggiata

### Requirement: TERM-05 — Al riavvio non si rilancia: si parcheggia, e la pane risveglia ciò che guarda

Al riavvio del server, una riga di terminale la cui pseudo-terminale non esiste
più NON SHALL essere RILANCIATA.

Rilanciare ogni riga rimasta, senza chiedersi se una scheda la mostri ancora né
da quanto sia ferma, riaccendeva per sempre le conversazioni chiuse: misurato il
03/08/2026, undici sessioni vive per **2,4 GB**, tutte di conversazioni chiuse fra
il 3 e il 29 luglio, riaccese insieme da un riavvio — e invisibili, perché non
esiste una vista per una sessione senza pane.

La riga SHALL essere lasciata DORMIENTE, e la pane SHALL risvegliarla da sola
quando torna attiva. Così un riavvio costa zero processi e ciò che si sta
guardando torna comunque su.

Una riga il cui trascritto NON esiste SHALL essere CANCELLATA: la ripresa
fallirebbe per sempre, e una riga che non può ripartire non è dormiente, è
morta. Ma un trascritto mancante NON SHALL mai cancellare una riga di un tipo che
non usa quel trascritto.

Una sessione il cui pane autonomo non ha una rianimazione SHALL essere
rilanciata: lì il parcheggio non ha chi lo risvegli.

#### Scenario: conversazione chiusa da settimane
- **GIVEN** una riga di una conversazione che nessuna scheda mostra
- **THEN** NON SHALL essere rilanciata al riavvio

#### Scenario: trascritto mancante su un tipo che non lo usa
- **GIVEN** una riga non basata su trascritto, senza trascritto
- **THEN** NON SHALL essere cancellata

### Requirement: TERM-06 — Un agente legge lo SCHERMO, non lo scrollback

Quando un agente deve sapere cosa c'è su un terminale, SHALL leggere lo SCHERMO —
la griglia risultante — e non il flusso grezzo di byte.

Su un programma che ridisegna IN PLACE — un menu con le frecce, una barra di
avanzamento, qualunque interfaccia a caratteri — i byte scritti non dicono cosa
c'è a schermo: dicono cosa è stato scritto, comprese tutte le versioni precedenti
della stessa riga. Chi legge il grezzo vede la STORIA, non lo STATO: non sa quale
voce è evidenziata, né se il tasto che ha premuto è arrivato.

La griglia SHALL essere ottenuta rigiocando il flusso su un emulatore, e
l'emulatore NON SHALL essere scritto a mano: le sequenze di controllo sono un
formato ostile — cursore, cancellazioni parziali, regioni di scorrimento,
larghezza doppia — e una copia artigianale sarebbe giusta sui casi provati e
sbagliata sugli altri, in silenzio.

SHALL essere riportata anche la posizione del CURSORE: è ciò che dice dove sta il
programma.

Le righe vuote in CODA SHALL potersi tagliare, quelle in MEZZO NO, e SHALL
esistere il modo di chiedere lo schermo intero.

La LARGHEZZA con cui si rigioca SHALL essere quella vera: rigiocare più stretti
manda a capo dove il programma non l'aveva fatto. Dimensioni assurde SHALL
ricadere sui valori di riferimento invece di rompersi, e un flusso vuoto SHALL
dare uno schermo vuoto, non un errore.

#### Scenario: un programma che ridisegna in place
- **GIVEN** un flusso che riscrive più volte la stessa riga
- **THEN** SHALL essere restituita solo l'ultima versione

#### Scenario: righe vuote in mezzo
- **GIVEN** uno schermo con righe vuote fra due righe piene
- **THEN** quelle in mezzo SHALL restare

### Requirement: TERM-07 — Un guscio dichiarato AUTONOMO non apre MAI il socket del ponte

Quando l'installazione è dichiarata autonoma, la funzione che assicura il ponte
NON SHALL MAI aprire un socket. L'incidente per cui esiste: un secondo server
che condivideva la stessa cartella di lavoro ha calcolato lo STESSO indirizzo di
socket di quello vivo, e la sua riconciliazione ha ucciso venticinque terminali
altrui.

Entrambe le forme con cui il flag può essere scritto SHALL essere lette, e SHALL
essere lette AL MOMENTO, non fotografate all'avvio.

Il ponte PROPRIO impacchettato SHALL RIABILITARE i terminali anche sotto il flag:
è nostro e non può collidere con nessuno.

Le variabili della vecchia implementazione, rimossa, NON SHALL più riabilitare
niente: un flag inerte che sembra vivo è una porta che nessuno sa di avere
aperto.

#### Scenario: il flag di autonomia acceso
- **GIVEN** l'installazione dichiarata autonoma
- **THEN** nessun socket SHALL essere aperto

#### Scenario: una vecchia variabile
- **GIVEN** una variabile della vecchia implementazione
- **THEN** NON SHALL riabilitare i terminali


### Requirement: TERM-08 — Risvegliare una sessione è SERIALIZZATO, e un ponte assente non è un rosso

Il risveglio di una sessione dormiente SHALL essere SERIALIZZATO sull'identificativo:
due client sulla stessa scheda passavano entrambi la lettura dello stato e ne
creavano DUE sotto la stessa voce.

Il perdente NON SHALL ricevere un rifiuto: sposterebbe il problema sul client, che
ne conierebbe un SECONDO. Entrambi SHALL ricevere la STESSA sessione.

Un risveglio su una sessione GIÀ VIVA SHALL restituire quella, senza crearne
un'altra.

Un ponte ASSENTE SHALL avere il proprio codice, DISTINTO da un guasto del ponte:
senza la distinzione, un checkout senza ponte tinge di rosso una suite sana —
misurato, l'unico rosso di oltre settemila casi.

#### Scenario: due risvegli concorrenti
- **GIVEN** due client sulla stessa sessione dormiente
- **THEN** SHALL essere creata una sola sessione, e entrambi SHALL riceverla

#### Scenario: nessun ponte disponibile
- **GIVEN** un ambiente senza ponte
- **THEN** SHALL essere dichiarata l'assenza, non un guasto

### Requirement: RESTART-SAY-01 — Un riavvio rifiutato lo DICE, e non si finge un'attesa

Il gesto che riavvia una sessione mostra un velo mentre la vecchia muore e la
nuova nasce. Quel velo si toglie quando la sessione torna, e ha un TETTO di
tempo come rete di sicurezza per il caso in cui non torni.

Il risultato della richiesta veniva BUTTATO VIA: nessun controllo sull'esito, e
la cattura degli errori era vuota. Ma il rifiuto ha tre forme — un riavvio già in
corso, una sessione che non esiste, un avvio fallito — e in tutte e tre il velo
restava per l'intero tetto e poi spariva in silenzio. È la forma esatta di «non
va, oppure si blocca»: sembra che stia lavorando, e non sta succedendo niente.

Un rifiuto SHALL togliere il velo SUBITO, e SHALL DIRE il motivo. Il tetto di
tempo SHALL restare quello che è — la rete per la riconnessione che non arriva —
e NON SHALL diventare il modo in cui si scopre che è andata male.

La stessa regola SHALL valere per il riavvio del SERVIZIO dal pannello di stato:
una cattura vuota lì riportava il comando da «in corso» a pronto come se fosse
riuscito, e le due mosse successive sono OPPOSTE — aspettare, oppure andare a
vedere perché.

Il motivo SHALL essere leggibile ACCANTO al comando che lo ha prodotto, dove la
superficie lo permette: un avviso che scorre via non è dove si va a cercare la
ragione di un gesto che non ha fatto niente.

#### Scenario: il servizio rifiuta il riavvio
- **GIVEN** una richiesta di riavvio respinta
- **THEN** il velo SHALL sparire subito, e il motivo SHALL essere leggibile

#### Scenario: il servizio non risponde
- **GIVEN** nessuna risposta alla richiesta
- **THEN** SHALL essere dichiarato, non atteso fino al tetto

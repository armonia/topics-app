## Purpose

Specifies behavioral scenarios for the chat messaging system including message lifecycle, rich content rendering, message actions, and input features.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic exists and is selected in the sidebar
- The chat panel is visible with the message input ready
## Requirements
### Requirement: CHAT-01 — Message Lifecycle

The system SHALL support sending messages, receiving streamed responses, loading conversation history, and aborting in-progress streams.

#### Scenario: Send message and receive streamed response
- **GIVEN** the message input is visible in an active topic
- **WHEN** the user types a message and presses Enter
- **THEN** the user message appears in the message list
- **AND** an assistant response streams in progressively

#### Scenario: Load message history on topic switch
- **GIVEN** two topics exist with different message histories
- **WHEN** the user switches from one topic to another
- **THEN** the new topic's message history loads in the message list

#### Scenario: Abort streaming via stop button
- **GIVEN** a message is being streamed with a streaming indicator visible
- **WHEN** the user clicks the stop button
- **THEN** streaming stops immediately
- **AND** the partial response text remains visible
- **AND** the message input becomes re-enabled

#### Scenario: Auto-scroll to bottom on new message
- **GIVEN** the user is viewing the latest messages at the bottom of the list
- **WHEN** a new assistant response arrives
- **THEN** the message list auto-scrolls to show the new content

#### Scenario: No auto-scroll when reading history
- **GIVEN** the user has scrolled up to read older messages
- **WHEN** a new assistant response arrives
- **THEN** the message list does NOT auto-scroll
- **AND** the user stays at their current scroll position

#### Scenario: Scroll-to-bottom button appears when scrolled up
- **GIVEN** the message list contains enough messages to scroll
- **WHEN** the user scrolls up away from the bottom
- **THEN** a scroll-to-bottom button appears
- **AND** clicking it scrolls to the latest message

#### Scenario: Multiline input with Shift+Enter
- **GIVEN** the message input is focused
- **WHEN** the user presses Shift+Enter
- **THEN** a new line is inserted in the input
- **AND** the message is NOT submitted

#### Scenario: Submit message via keyboard shortcut
- **GIVEN** the message input contains text
- **WHEN** the user presses Ctrl+Enter
- **THEN** the message is submitted

#### Scenario: Empty message submission is blocked
- **GIVEN** the message input is empty
- **WHEN** the user presses Enter
- **THEN** no message is sent
- **AND** the input remains focused

### Requirement: CHAT-02 — Rich Content Rendering

The system SHALL render rich content types within messages including markdown, code blocks, diffs, sub-agent cards, plan mode views, and tool call results.

#### Scenario: Markdown text renders with formatting
- **GIVEN** an assistant message contains markdown syntax including bold, inline code, and lists
- **WHEN** the message is displayed in the message list
- **THEN** bold text appears with strong emphasis
- **AND** inline code appears with distinct styling
- **AND** lists render as properly formatted items

#### Scenario: Code blocks render with syntax highlighting
- **GIVEN** an assistant message contains a fenced code block with a language identifier
- **WHEN** the message is displayed in the message list
- **THEN** the code block renders in a distinct container
- **AND** the code content preserves whitespace and formatting

#### Scenario: Diff block shows file changes with apply and reject actions
- **GIVEN** an assistant message contains a search-and-replace diff for a file
- **WHEN** the message is displayed in the message list
- **THEN** a diff block renders showing the file path
- **AND** an Apply button is visible to accept the change
- **AND** a Reject button is visible to discard the change

#### Scenario: Diff block apply action applies the change
- **GIVEN** a diff block is displayed with pending status
- **WHEN** the user clicks the Apply button
- **THEN** the file change is applied to the source file
- **AND** the diff block shows an applied status indicator

#### Scenario: Diff block reject action discards the change
- **GIVEN** a diff block is displayed with pending status
- **WHEN** the user clicks the Reject button
- **THEN** the change is discarded without modifying the file
- **AND** the diff block shows a rejected status indicator

#### Scenario: Sub-agent spawn card shows agent name and status
- **GIVEN** an assistant message contains a sub-agent spawn marker
- **WHEN** the message is displayed in the message list
- **THEN** a spawn card renders showing the agent task label
- **AND** the card displays the agent's current status
- **AND** token usage information is shown

#### Scenario: Plan mode displays steps with execute and reject options
- **GIVEN** an assistant message contains a numbered implementation plan
- **WHEN** the message is displayed in the message list
- **THEN** a plan view renders showing the individual steps
- **AND** an Execute Plan button is visible
- **AND** a Reject button is visible

#### Scenario: Tool call card shows tool name and execution status
- **GIVEN** an assistant message includes a tool call invocation
- **WHEN** the message is displayed in the message list
- **THEN** a tool call card renders showing the tool name
- **AND** the card shows the execution status (success or error)

#### Scenario: Tool call card expands to show arguments and result
- **GIVEN** a tool call card is displayed in a message
- **WHEN** the user clicks on the tool call card
- **THEN** the card expands to show the tool arguments
- **AND** the tool result or output is displayed

#### Scenario: Tool call error renders with error styling
- **GIVEN** a tool call completed with an error
- **WHEN** the tool call card is displayed in the message list
- **THEN** the card shows an error status indicator
- **AND** expanding the card reveals the error message

#### Scenario: Image attachment renders as inline thumbnail
- **GIVEN** an assistant message includes an image attachment
- **WHEN** the message is displayed in the message list
- **THEN** the image renders as a visible thumbnail

#### Scenario: Image attachment opens lightbox on click
- **GIVEN** an image thumbnail is displayed in a message
- **WHEN** the user clicks on the image
- **THEN** a lightbox overlay opens showing the full-size image
- **AND** a close button is available to dismiss the lightbox

#### Scenario: File attachment renders as download link
- **GIVEN** an assistant message includes a non-image file attachment
- **WHEN** the message is displayed in the message list
- **THEN** a file attachment element renders showing the filename
- **AND** the element links to the file for download

### Requirement: CHAT-03 — Message Actions

The system SHALL provide message-level actions including pinning, branching, hover toolbar, and navigation controls.

#### Scenario: Hover toolbar appears on message hover
- **GIVEN** a message is displayed in the message list
- **WHEN** the user hovers over the message
- **THEN** a floating action toolbar appears with action buttons

#### Scenario: Copy message copies text to clipboard
- **GIVEN** the hover toolbar is visible on a message
- **WHEN** the user clicks the Copy button
- **THEN** the message text is copied to the clipboard
- **AND** the Copy button changes to a success indicator

#### Scenario: Pin message toggles pin status
- **GIVEN** the hover toolbar is visible on a message
- **WHEN** the user clicks the Pin button
- **THEN** the message is marked as pinned
- **AND** the Pin button changes to indicate pinned state

#### Scenario: Unpin message removes pin status
- **GIVEN** a message is currently pinned
- **WHEN** the user hovers over the message and clicks the Pin button
- **THEN** the message is unpinned
- **AND** the Pin button returns to its default state

#### Scenario: Pinned messages panel shows pinned messages
- **GIVEN** one or more messages are pinned in the current topic
- **WHEN** the chat panel renders
- **THEN** a pinned messages section appears above the message list
- **AND** each pinned message shows a preview of its content

> Note: Pinned messages panel component exists; functional status in current UI may be a gap.

#### Scenario: Reply to message creates threaded reply
- **GIVEN** the hover toolbar is visible on a message
- **WHEN** the user clicks the Reply button
- **THEN** the message input shows a reply indicator referencing the original message

#### Scenario: Edit message opens editing mode
- **GIVEN** a user message is displayed in the message list
- **WHEN** the user hovers over the message and clicks the Edit button
- **THEN** the message input switches to editing mode
- **AND** an "Editing message" indicator is visible
- **AND** the original message text appears in the input field

#### Scenario: Branch from edited message creates new conversation branch
- **GIVEN** a user message is in editing mode
- **WHEN** the user modifies the text and submits the edit
- **THEN** a new conversation branch is created with the edited content
- **AND** the assistant provides a new response for the edited message

#### Scenario: Navigate between branches with arrows
- **GIVEN** a message has multiple conversation branches
- **WHEN** the user views the branched message
- **THEN** previous and next branch navigation buttons appear
- **AND** a branch counter shows the current position (e.g., "2/3")
- **AND** clicking navigation buttons switches between branches

### Requirement: CHAT-04 — Input Features

The system SHALL provide input enhancements including @mentions, slash commands, file attachments, voice recording, and context display.

#### Scenario: Input toolbar displays all action buttons
- **GIVEN** the chat panel is active with a topic selected
- **WHEN** the message input area is visible
- **THEN** an Attach file button is visible
- **AND** a Toggle plan mode button is visible
- **AND** a Record voice button is visible
- **AND** a Tools button is visible
- **AND** a Send message button is visible

#### Scenario: @mention shows autocomplete dropdown
- **GIVEN** the topic has a linked project folder
- **WHEN** the user types @ in the message input
- **THEN** a mention autocomplete menu appears with file suggestions

#### Scenario: @mention selects file and adds context
- **GIVEN** the mention autocomplete menu is open with file suggestions
- **WHEN** the user selects a file from the dropdown
- **THEN** the selected file is added as context for the message

#### Scenario: Slash command menu appears on / input
- **GIVEN** the message input is focused
- **WHEN** the user types / in the input
- **THEN** a slash command menu appears showing available commands
- **AND** commands such as /status, /help, and /clear are listed

#### Scenario: Slash command executes selected command
- **GIVEN** the slash command menu is visible
- **WHEN** the user selects and submits a command
- **THEN** the command executes
- **AND** a result indicator appears confirming the action

#### Scenario: File attachment shows preview before send
- **GIVEN** the message input is visible
- **WHEN** the user attaches a file via the file picker
- **THEN** a preview of the attached file appears in the input area showing the filename

#### Scenario: Voice recording button starts and stops recording
- **GIVEN** the message input toolbar is visible
- **WHEN** the user clicks the Record voice button
- **THEN** the recording interface activates with a recording timer
- **AND** clicking the button again stops the recording

> Note: Voice recording has limited test coverage. Full recording-to-transcription behavior may be a gap.

#### Scenario: Context pills display attached context sources
- **GIVEN** a topic has context files attached
- **WHEN** the chat panel is visible for that topic
- **THEN** context pills appear near the input showing the attached filenames

#### Scenario: Plan mode toggle switches input behavior
- **GIVEN** the message input toolbar is visible
- **WHEN** the user clicks the Toggle plan mode button
- **THEN** the input mode switches between normal and plan mode

#### Scenario: @mention menu requires project folder
- **GIVEN** the topic does not have a linked project folder
- **WHEN** the user types @ in the message input
- **THEN** no mention autocomplete menu appears

### Requirement: CHAT-05 — Checkpoints

The system SHALL support creating conversation checkpoints as snapshots, displaying them in a compact timeline view, expanding to see checkpoint details, and rolling back to a previous checkpoint with confirmation.

A rollback SHALL touch only the files THIS chat changed since the checkpoint, decided by a plan built before anything is written (`POST /api/topics/:id/checkpoints/:idx/plan`, `POST /api/topics/:id/turn-checkpoints/plan`). It SHALL never stash or rewrite the whole working tree, and it SHALL never move HEAD.

#### Scenario: Checkpoint bar shows count and timeline dots
- **GIVEN** a topic has one or more saved checkpoints
- **WHEN** the checkpoint timeline component renders
- **THEN** a compact bar displays the checkpoint count (e.g., "3 checkpoints")
- **AND** small colored dots represent the most recent checkpoints (up to 8)
- **AND** dots with a git hash appear in primary color while others use placeholder color

#### Scenario: Checkpoint bar is hidden when no checkpoints exist
- **GIVEN** a topic has no saved checkpoints
- **WHEN** the checkpoint timeline component renders
- **THEN** the component renders nothing (no bar is visible)

#### Scenario: Clicking checkpoint bar expands the timeline
- **GIVEN** the compact checkpoint bar is visible
- **WHEN** the user clicks the bar
- **THEN** the timeline expands to show a detailed list of all checkpoints
- **AND** the bar label changes from "Show" to "Hide"

#### Scenario: Expanded timeline lists checkpoint details
- **GIVEN** the checkpoint timeline is expanded
- **WHEN** checkpoint entries are displayed
- **THEN** each entry shows a colored dot, description text, relative timestamp, and message count
- **AND** checkpoints with a git hash show the abbreviated hash in primary color

#### Scenario: Save button creates a new checkpoint
- **GIVEN** the checkpoint timeline is expanded
- **WHEN** the user clicks the "Save" button with the Plus icon
- **THEN** a new checkpoint is created via the API
- **AND** the new checkpoint appears at the bottom of the timeline list
- **AND** when the topic has a project folder the checkpoint also records a snapshot of the working tree (`treeCommit`), on the same ref namespace as the automatic per-turn checkpoints

#### Scenario: Hovering a checkpoint reveals rollback button and asks for the plan
- **GIVEN** the checkpoint timeline is expanded with entries listed
- **WHEN** the user hovers over a checkpoint entry
- **THEN** a rollback button (rotate-ccw icon) appears on the right side of the entry
- **AND** the entry background highlights on hover
- **AND** the plan preflight for that checkpoint is requested once and cached, so hovering again does not ask again

#### Scenario: Rollback button is disabled with a written reason when the plan is refused
- **GIVEN** the plan preflight answers `canProceed: false` (a turn is still running in this chat, another chat has snapshotted in the folder since, or the snapshot does not exist)
- **WHEN** the rollback button is shown on the hovered entry
- **THEN** the button is disabled
- **AND** its title is the reason in the user's language, never the raw blocker code

#### Scenario: Clicking rollback shows a confirmation dialog that says what the plan says
- **GIVEN** the rollback button is enabled on a checkpoint entry
- **WHEN** the user clicks the rollback button
- **THEN** a confirmation dialog appears, mentioning the checkpoint description and the message count the conversation is cut back to
- **AND** the dialog says how many files come back and how many files the chat created since will be deleted
- **AND** when the plan skipped paths, one line says those paths were changed by somebody else and are left alone, naming up to five of them and folding the rest as "+N more"
- **AND** the dialog never promises a git checkout to a hash

#### Scenario: Confirming rollback restores only the paths of the turn
- **GIVEN** the user confirms a rollback on a checkpoint with a tree snapshot
- **WHEN** the rollback runs
- **THEN** files this chat modified or deleted since the checkpoint are written back from the snapshot
- **AND** files this chat created since the checkpoint are deleted
- **AND** files this chat never touched keep whatever they hold now, uncommitted edits included
- **AND** HEAD stays on its branch and nothing is stashed
- **AND** the conversation is truncated to the checkpoint's message count and later checkpoints are removed

#### Scenario: A path changed by somebody else is skipped and named
- **GIVEN** a path the chat changed was edited again by somebody else after the chat's last snapshot
- **WHEN** the rollback runs
- **THEN** that path is left as it is
- **AND** the response lists it under `skipped` with the reason `changed-after-checkpoint`, and the UI names it

#### Scenario: A refused rollback touches nothing
- **GIVEN** the plan is refused because a turn is still running in this chat or another chat has written in the folder since
- **WHEN** the rollback endpoint is called anyway
- **THEN** it answers 409 with the plan and its blockers
- **AND** no file is touched and the conversation is not truncated

#### Scenario: A legacy checkpoint rolls back the conversation only
- **GIVEN** a checkpoint saved before tree snapshots existed (no `treeCommit`), or a topic without a project folder
- **WHEN** the user rolls back to it
- **THEN** the conversation is truncated and later checkpoints removed
- **AND** nothing on disk is touched
- **AND** the plan preflight answers `canProceed: true, filesRestorable: false` with the blocker `legacy-checkpoint` (or `not-a-repo`), so the button stays enabled and the dialog says in one line that the files cannot come back

#### Scenario: A turn whose end was never recorded is refused, not guessed
- **GIVEN** a turn took its `before` snapshot and its end-of-turn mark was never written (the process died between the two)
- **AND** the working tree has changed since that snapshot, with no turn running now
- **WHEN** the plan is built for that checkpoint
- **THEN** it carries the blocker `no-turn-mark` and restores nothing
- **AND** the reason shown says the files of that turn cannot be told apart from anybody else's

#### Scenario: A turn that wrote nothing still records its end
- **GIVEN** a turn that changed no file
- **WHEN** the turn ends
- **THEN** an end-of-turn mark is recorded anyway, with the same tree as the snapshot before it
- **AND** a later edit by hand does NOT make that checkpoint look like a turn whose end was lost: its plan is empty and safe
- **AND** the checkpoint window counts restore points, so the marks do not halve how far back a chat can go

#### Scenario: Cancelling rollback preserves current state
- **GIVEN** the rollback confirmation dialog is displayed
- **WHEN** the user cancels the dialog
- **THEN** no rollback occurs
- **AND** the checkpoint list remains unchanged

#### Scenario: Rollback failure shows an error notice
- **GIVEN** the user confirms a rollback
- **WHEN** the rollback API call fails
- **THEN** a toast displays a "Rollback failed" message with the error details, or the translated blocker reason when the server refused the plan

#### Scenario: Successful rollback with skipped paths shows a notice
- **GIVEN** the user confirms a rollback whose plan skipped paths
- **WHEN** the rollback succeeds
- **THEN** a toast says how many paths were left alone because somebody else changed them

#### Scenario: Collapsing the timeline hides checkpoint details
- **GIVEN** the checkpoint timeline is expanded
- **WHEN** the user clicks the compact bar again
- **THEN** the detailed checkpoint list collapses
- **AND** only the compact bar with count and dots remains visible


### Requirement: CHAT-CHANGES-01 - Cosa ha toccato questa conversazione

Il sistema SHALL ricavare dalle tool call di scrittura di un topic (`detail.type` `write`
o `edit`) l'elenco dei file che quella conversazione ha creato, modificato o cancellato, e
SHALL esporlo su `GET /api/topics/:id/changes` come `{ files: [{ path, kind, turns, lastAt,
added?, removed? }], git: { root, branch, dirty } | null }`.

Quando il topic lavora dentro un repository git, il sistema SHALL incrociare quei path con
`git status --porcelain` e `git diff --numstat` LIMITATI a quei path: i conteggi e lo stato
descrivono il lavoro di QUESTA conversazione, non lo sporco dell'intero repository. Fuori da
un repository la risposta SHALL restare utile (i path e il tipo dedotto dalle tool call) con
`git: null`.

SOPRA IL COMPOSER della chat - nel blocco di fondo della pane, sulla colonna della chat,
insieme alle altre strisce che stanno sopra l'input (todo, sotto-agenti, checkpoint) - il
sistema SHALL mostrare un chip con il numero dei file del topic; il chip SHALL essere assente
quando la conversazione non ha scritto nulla, e in quel caso il blocco di fondo SHALL restare
all'altezza che aveva. La striscia non SHALL stare nel chrome sopra la barra delle tab ne'
dentro il transcript. L'elenco SHALL aggiornarsi a fine turno (`stream:end`), non a ogni
token.

Il nome del branch SHALL comparire nella striscia SOLO quando il topic e' legato a un
worktree isolato (`worktreeId` non nullo) e il topic lavora dentro un repository: e' il ramo
del topic, che nessun'altra parte dello schermo dice. Per un topic senza worktree la striscia
SHALL mostrare solo il chip dei file, anche quando git ha risposto: il branch e' quello del
progetto, che la sidebar mostra gia'.

Su un topic a cui e' stato dispatchato un task l'elenco SHALL venire dalla gamma di diff del
task, la stessa che disegna il drawer (worktree vivo, poi merge del land, poi commit di
consegna): path relativi al repository e conteggi di git, compresi i file scritti da un comando
di shell o da un sotto-agente. Una tool call SHALL fondersi con la riga della gamma dello stesso
file solo se ha scritto nel worktree del task: finche' esiste, il suo path; dopo la potatura,
la cartella che il ramo `topics/<nome>` nomina (quello della consegna registrata o, senza
consegna, quello del tentativo lanciato nel topic). Le altre scritture SHALL restare righe
proprie. Una riga della gamma SHALL aprire il drawer del task su quel file. Senza una gamma
leggibile, o con una gamma letta dal commit di consegna che contiene piu' file di quanti la
review ne ha misurati in quella consegna, l'elenco SHALL restare quello delle tool call. Un
topic senza task SHALL restare sulle sue tool call anche dentro un worktree: nulla dice di chi
sia la gamma di un worktree che la sidebar puo' aver aperto a un secondo topic.

#### Scenario: il chip compare dopo un turno che ha scritto
- **GIVEN** un topic la cui conversazione contiene una tool call `write` su un file
- **WHEN** l'utente guarda il blocco sopra il composer della chat
- **THEN** vede un chip con il conteggio dei file toccati, sopra l'input e sulla sua stessa colonna
- **AND** cliccandolo si apre l'elenco con il path relativo e lo stato del file

#### Scenario: una conversazione che non ha scritto niente non mostra il chip
- **GIVEN** un topic le cui tool call sono solo letture, ricerche e comandi
- **WHEN** l'utente guarda il blocco sopra il composer della chat
- **THEN** non c'e' nessun chip dei file modificati

#### Scenario: un topic senza worktree non mostra il branch
- **GIVEN** un topic non legato a un worktree, la cui conversazione ha scritto dei file
- **WHEN** l'utente guarda la striscia sopra il composer
- **THEN** vede il chip con il conteggio dei file
- **AND** non vede nessun nome di branch, nemmeno se il topic lavora dentro un repository

#### Scenario: un topic legato a un worktree mostra il suo branch
- **GIVEN** un topic con `worktreeId` non nullo, che lavora dentro un repository e ha scritto dei file
- **WHEN** l'utente guarda la striscia sopra il composer
- **THEN** accanto al chip vede il nome del branch del worktree, con la root del repository come titolo

#### Scenario: i conteggi vengono da git e riguardano solo i file del topic
- **GIVEN** un topic dentro un repository con due `write` su file nuovi e un `edit` su un file gia' committato
- **AND** un altro file del repository sporco, che la conversazione non ha mai nominato
- **WHEN** si legge `GET /api/topics/:id/changes`
- **THEN** l'elenco contiene i tre file della conversazione, due come `created` e uno come `modified`
- **AND** ogni riga porta le righe aggiunte e tolte da `git diff --numstat`
- **AND** il file sporco che la conversazione non ha toccato non compare

#### Scenario: dalla riga al diff
- **GIVEN** l'elenco dei file modificati e' aperto
- **WHEN** l'utente clicca su una riga che non viene dalla gamma di un task
- **THEN** il diff di quel file si apre nella pane editor

#### Scenario: il topic di un task atterrato elenca la gamma del land
- **GIVEN** un task atterrato con `merge task <id>` e il suo worktree potato
- **AND** una conversazione che ha scritto `src/a.ts` nel worktree con una tool call, e `gen.sh` con un comando di shell
- **WHEN** si legge `GET /api/topics/:id/changes`
- **THEN** ogni file compare una volta sola, relativo al repository, con i conteggi del merge
- **AND** la riga di `src/a.ts` porta i turni della tool call, quella di `gen.sh` zero turni

#### Scenario: dalla riga della gamma al drawer del task
- **GIVEN** l'elenco dei file modificati di un topic di task e' aperto
- **WHEN** l'utente clicca su una riga della gamma del task
- **THEN** si apre il drawer del task sul pannello delle modifiche, con quel file a fuoco

#### Scenario: un topic senza task nel worktree di un altro topic
- **GIVEN** due topic legati allo stesso worktree, nessuno dei due con un task
- **AND** il primo ha scritto e committato dei file, il secondo ha solo letto
- **WHEN** si legge `GET /api/topics/:id/changes` del secondo
- **THEN** l'elenco e' vuoto

Le RIGHE dell'elenco non sono di questa striscia: sono il componente condiviso
descritto da `GIT-FILELIST-01` (lettera di stato, percorso col nome intero,
conteggi o «bin»), lo stesso che monta il chip di consegna di una card. Qui
restano il chip, il conteggio, il branch e l'apertura del diff.

### Requirement: CHAT-TOOL-01 — Lo stato "running" copre l'utilizzo reale del tool

Il sistema SHALL mostrare una tool call come attiva (`running`) per tutta la finestra di
utilizzo reale: dalla partenza della generazione dell'input da parte del modello fino
all'arrivo del risultato — non solo durante l'esecuzione. Il `ToolCall` SHALL registrare
`startedAt`/`endedAt` e la UI SHALL mostrare la durata reale.

#### Scenario: tool con input lungo appare subito
- **GIVEN** un turno claude-code in cui il modello genera un Edit con input corposo
- **WHEN** il modello inizia a scrivere l'input del tool
- **THEN** la riga del tool appare subito in stato running (nome noto, args in arrivo)
- **AND** resta running finché il risultato non arriva

#### Scenario: durata reale visibile
- **GIVEN** una tool call completata
- **WHEN** l'utente guarda la riga
- **THEN** vede la durata effettiva (endedAt − startedAt) accanto allo stato

#### Scenario: args completi al termine della generazione
- **GIVEN** una tool call annunciata con args parziali
- **WHEN** l'input del tool è completo
- **THEN** la riga si aggiorna con gli args completi senza duplicare la call

### Requirement: CHAT-TOOL-02 — Aggregazione dei gruppi di tool call

Il sistema SHALL collassare i gruppi di tool call consecutive con 3 o più call in una
riga di sintesi con conteggi per tool e durata totale, espandibile al click nelle righe
per-call. Con il gruppo ancora in streaming, la sintesi delle call completate e la call
attiva (body aperto) SHALL essere visibili insieme. `waiting_for_input` e sub-agent non
si aggregano mai; gli errori SHALL restare visibili (conteggio) anche a gruppo chiuso.

#### Scenario: gruppo settled collassato con conteggi
- **GIVEN** un messaggio con 12 tool call consecutive completate
- **WHEN** l'utente guarda il messaggio
- **THEN** vede una sola riga di sintesi (es. "12 azioni · Read ×5 · Edit ×3 · Bash ×4")
- **AND** al click si espande nella lista delle 12 righe per-call

#### Scenario: la sintesi dice COSA è stato fatto, non solo quante volte
- **GIVEN** un gruppo collassato con comandi shell e file toccati
- **WHEN** l'utente guarda la riga di sintesi
- **THEN** sotto i conteggi vede gli highlights per tipo (comandi eseguiti, basename
  dei file, pattern cercati, host fetchati), dedupati in ordine di esecuzione

#### Scenario: gruppo live mostra la call attiva
- **GIVEN** un turno in streaming con 5 call completate e una in esecuzione
- **WHEN** l'utente guarda il messaggio
- **THEN** vede la sintesi delle 5 completate e la call attiva col pannello aperto

#### Scenario: errore visibile a gruppo chiuso
- **GIVEN** un gruppo settled con una call in errore
- **WHEN** il gruppo è collassato
- **THEN** la sintesi espone il conteggio errori con accento rosso

#### Scenario: il form di input non si aggrega
- **GIVEN** un gruppo di call in cui una è `waiting_for_input`
- **WHEN** il messaggio renderizza
- **THEN** la call col form resta una riga autonoma col form visibile

### Requirement: CHAT-TOOL-06 — Nella chat di un task il lavoro macchina sta in un accordion

Nella chat che è la SESSIONE di un task (topic legato a una scheda di board), il sistema
SHALL ripiegare il lavoro macchina di un turno — messaggi dell'agente senza prosa che
portano solo tool call, sotto-agenti o ragionamento — in UN accordion chiuso di default
per tratto contiguo di lavoro, con una riga di riepilogo (numero di azioni, conteggi per
tool, durata, file scritti, sotto-agenti, errori) e apertura al click sulle stesse righe
per-azione di sempre. Prosa dell'agente, domande all'umano, consegne e messaggi umani
SHALL restare in chiaro. Il sistema SHALL NON ripiegare ciò che aspetta una persona
(`waiting_for_input`, permessi) né il lavoro ancora in corso, e SHALL NON riordinare la
cronologia: la prosa scritta a metà turno resta al suo posto e spezza il tratto. In una
chat che non è la sessione di un task il comportamento SHALL restare invariato.

#### Scenario: dieci azioni dietro una riga sola
- **GIVEN** la chat di un task con un messaggio umano, dieci tool call in dieci messaggi,
  una risposta in prosa e una domanda all'umano
- **WHEN** l'utente apre la chat
- **THEN** vede un accordion chiuso che dichiara «10 azioni», i conteggi per tool, la
  durata e i file scritti
- **AND** nessuna riga per-azione è a schermo
- **AND** la prosa e la domanda sono visibili

#### Scenario: il click restituisce tutto
- **GIVEN** l'accordion chiuso del turno
- **WHEN** l'utente lo apre
- **THEN** dentro ci sono le stesse righe per-azione che il transcript renderizzava prima

#### Scenario: una chat normale non cambia
- **GIVEN** la stessa sequenza di messaggi in una chat che non è la sessione di un task
- **WHEN** l'utente la apre
- **THEN** non c'è nessun accordion di turno e le corse di tool si vedono come prima
  (CHAT-TOOL-02)

#### Scenario: ciò che aspetta una persona non si piega
- **GIVEN** un turno in cui una call è `waiting_for_input` o è ancora in esecuzione
- **WHEN** il transcript renderizza
- **THEN** quel messaggio resta in chiaro, fuori dall'accordion

### Requirement: CHAT-TOOL-03 — Niente flash del pannello per i tool rapidi

Il body auto-aperto di una tool call running SHALL aprirsi solo se l'esecuzione supera
una soglia percettiva (~250ms) e, una volta aperto, restare visibile per un tempo minimo
(~1.5s) anche se il tool termina prima. Un toggle esplicito dell'utente SHALL sempre
prevalere sull'automatismo.

#### Scenario: tool istantaneo non sfarfalla
- **GIVEN** una tool call che completa in meno di 250ms
- **WHEN** la call passa da running a success
- **THEN** il body non si è mai auto-aperto (nessun flash open/close)

#### Scenario: tool breve resta leggibile
- **GIVEN** una tool call che completa in ~500ms
- **WHEN** il body si è auto-aperto
- **THEN** resta aperto almeno il dwell minimo prima di collassare

### Requirement: CHAT-FOLD-01 — A fold opened by hand does not move the transcript

Every expand/collapse surface a person can click in a topic's chat (a run of tool
calls, a single tool row and its lazily fetched output, a sub-agent card, the
folded work of a finished turn, a reasoning row, the details of a turn error, a
long code block, the compaction recap, a dispatcher envelope, a process exit
line, the body of a message that is a `/command`) SHALL keep the header that was clicked at the same position on screen
(within 1 px, vertically and horizontally) in every painted frame while its body
opens or closes, and nothing above that header SHALL move. The body grows or
shrinks below the header in one continuous change: a body SHALL NOT appear as a
placeholder and then jump to its real height (a trimmed tool output is fetched
before the reveal, within a bound). This holds both with the chat at its bottom,
where the list follows new output, and in the middle of a long history.

A toggle by hand takes the view from the bottom-follow for that toggle, like a
scroll does: the list does not re-pin to the bottom while the body settles, and
afterwards the follow comes back only when the reader is at the true bottom again
(or sends, or asks for the bottom). A second click on the same header while it
is still closing (a quick close and reopen) is part of the same hold, not a
scroll. Closing a fold near the end keeps the missing height as empty room below
the last row instead of pulling every row down; that room is given back as soon
as it is out of sight or filled by new output, and a scroll down past the end
(wheel or finger) takes it away by the same amount, so the last row comes back
onto the composer under the reader's own hand. Motion
is the shared height animation of the body (`MOTION.base`), and nothing animates
under `prefers-reduced-motion`.

The strips docked above the composer (the goal, the todo list, the files this
chat touched, the checkpoints) open their content ABOVE their header, in the
flow of the docked block: the header keeps its place under the pointer, and a
transcript that was following the bottom follows the block up, so its newest
row is never hidden under the opened list (while the agent writes, too). A
transcript read further up does not move.

#### Scenario: opening a fold at the bottom of the chat
- **GIVEN** a chat at its true bottom whose last message holds a closed fold
- **WHEN** the person clicks the fold's header
- **THEN** in every frame for 900 ms the header stays within 1 px of where it was, horizontally too
- **AND** the message row above it does not move
- **AND** the body opens below the header, in one run of growth

#### Scenario: closing a fold at the bottom of the chat
- **GIVEN** the same fold, open, with the chat at its bottom
- **WHEN** the person clicks the header again
- **THEN** the header and the rows above it stay where they were while the body closes
- **AND** the room left below the last row is given back when the reader scrolls up or new output arrives

#### Scenario: closed and reopened at once at the true bottom
- **GIVEN** a fold open at the end of the chat, read down to the true bottom
- **WHEN** the person presses its header twice in a row, the second press while the body is still closing
- **THEN** the header stays within 1 px of where it was in every frame
- **AND** the fold ends open

#### Scenario: the room left near the end scrolls away
- **GIVEN** a tall fold near the end closed with its header near the top of the view, leaving empty room below the last row
- **WHEN** the reader scrolls down with the wheel
- **THEN** the room goes and the last row rests on the composer again

#### Scenario: a fold in the middle of a long history
- **GIVEN** a reader who scrolled two screens up with the wheel
- **WHEN** they open and then close a fold there
- **THEN** the header and everything above it stay where they were in every frame of both

#### Scenario: a trimmed tool output does not pop in
- **GIVEN** a finished tool row whose output the history shipped blank
- **WHEN** the person opens it
- **THEN** the body opens onto the whole output in one run, not onto a loading line that the output pushes down later

#### Scenario: a strip docked over the composer
- **GIVEN** the goal bar, the todo strip or the changed-files strip above the composer
- **WHEN** the person opens and closes it
- **THEN** the strip's header stays where it was
- **AND** with the chat at its bottom the newest row stays in sight above the opened list; read further up, the rows on screen do not move

#### Scenario: a docked list open while the agent writes
- **GIVEN** the todo strip open with the chat at its bottom
- **WHEN** the agent streams new output
- **THEN** the newest streamed word is painted in sight, not under the list

#### Scenario: the follow comes back
- **GIVEN** a fold opened by hand at the bottom, its body now below the fold
- **WHEN** new output arrives
- **THEN** the view stays on the header the person opened
- **AND** once the reader scrolls back to the true bottom, or sends, new output is followed again

### Requirement: CHAT-TOOL-04 — Codice formattato nei body dei tool

Il sistema SHALL evidenziare la sintassi del codice mostrato nei body dei tool
(Read/Write/Edit content, comando Shell) con l'infrastruttura hljs esistente, derivando
la lingua dall'estensione del file. Il fallback per lingua ignota/oversize/tokenizer
non pronto SHALL restare il testo piatto attuale.

#### Scenario: Read di un file TypeScript evidenziato
- **GIVEN** una tool call Read completata su un file `.ts`
- **WHEN** l'utente espande il body
- **THEN** il contenuto mostra token evidenziati (keyword, stringhe) come i code fence

#### Scenario: fallback su lingua ignota
- **GIVEN** una tool call Read su un file con estensione non riconosciuta
- **WHEN** l'utente espande il body
- **THEN** il contenuto renderizza come testo monospace piatto (comportamento attuale)

### Requirement: CHAT-CACHE-01 — I provider SDK marcano il prefisso stabile come cacheabile

Il sistema SHALL marcare con un breakpoint di prompt caching le porzioni ripetute del
prefisso inviato ai provider che parlano direttamente con l'SDK Anthropic, in modo che le
richieste successive della stessa conversazione le rileggano dalla cache invece di
riprefillarle.

#### Scenario: Gli schemi dei tool sono cacheati

- **GIVEN** una richiesta che include definizioni di tool
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** l'ultima definizione di tool porta un marker di cache effimera

#### Scenario: Il preambolo di sistema è cacheato

- **GIVEN** una richiesta con un messaggio di sistema non vuoto
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** il preambolo di sistema è espresso come blocchi di testo
- **AND** l'ultimo blocco porta un marker di cache effimera

#### Scenario: La conversazione fino al turno corrente è cacheata

- **GIVEN** una richiesta con almeno un messaggio in conversazione
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** l'ultimo messaggio porta un marker di cache effimera

#### Scenario: Non si superano i breakpoint consentiti

- **GIVEN** una richiesta con tool, sistema e conversazione tutti presenti
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** il numero totale di marker di cache non supera quattro

#### Scenario: Una richiesta senza parti stabili resta invariata

- **GIVEN** una richiesta senza tool, senza sistema e senza messaggi
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** nessun marker di cache viene applicato

### Requirement: CHAT-DEF-01 — La chat funziona senza toggle di Settings

Il sistema SHALL rendere la chat strutturata utilizzabile out-of-the-box: creare una nuova
chat e inviare un messaggio SHALL funzionare senza che l'utente attivi alcun toggle in
Settings, quando è disponibile almeno un provider chat `ready`.

#### Scenario: nuovo topic invia e riceve con provider subscription pronto
- **GIVEN** `claude-code` è `ready` e `claude` (SDK) non ha una API key usabile
- **WHEN** l'utente crea un nuovo topic e invia un messaggio senza scegliere un provider
- **THEN** il messaggio viene dispatchato a `claude-code` (non a `claude`)
- **AND** l'utente riceve una risposta assistita (nessun "No response received")

#### Scenario: le entry-point di creazione chat sono visibili di default
- **GIVEN** un'installazione con impostazioni di default
- **WHEN** l'utente apre l'app
- **THEN** le affordance di nuova chat (sidebar +, ⌘⇧N, command palette) sono disponibili
- **AND** non è necessario abilitare `enableNewChat` in Settings

### Requirement: CHAT-DEF-02 — Default provider onesto e subscription-first

Il sistema SHALL NON considerare connesso/usabile un provider `claude` (SDK) privo di API
key, e SHALL preferire come default automatico il path coperto da subscription
(`claude-code`, poi `codex`) rispetto ai path metered (`claude`, `openai`) quando il default
corrente non è connesso. L'override esplicito (`AI_PROVIDER`) e la scelta per-topic SHALL
avere sempre la precedenza.

#### Scenario: claude senza key non è il default
- **GIVEN** `claude` è registrato ma senza API key usabile, e `claude-code` è connesso
- **WHEN** il registro ricalcola il default
- **THEN** `claude` non è riportato connesso
- **AND** il default risolto è `claude-code`

#### Scenario: override esplicito rispettato
- **GIVEN** `AI_PROVIDER=claude` o un topic con `provider` esplicito
- **WHEN** si risolve il provider
- **THEN** viene usato il provider richiesto, non il default subscription-first

### Requirement: CHAT-DEF-03 — Lista modelli aggiornata nel picker

Il sistema SHALL esporre per `claude-code` la lista dei modelli correnti supportati dalla
CLI installata, con il modello configurato in testa (così `models[0]` resta il default
effettivo). Il ProviderModelPicker SHALL mostrare questi modelli come selezionabili.

#### Scenario: il picker mostra modelli correnti
- **GIVEN** il provider `claude-code` è `ready`
- **WHEN** l'utente apre il ProviderModelPicker
- **THEN** vede i modelli correnti (Opus 4.8 / Sonnet / Haiku / Fable 5), non versioni datate
- **AND** selezionandone uno, i turni successivi usano quel modello

### Requirement: CHAT-DEF-04 — Controlli del composer sensati e cablati

Ogni controllo interattivo del composer chat SHALL essere cablato a un handler funzionante,
avere label/tooltip sensati, e riflettere lo stato reale. Le slash-command e la voce
`/model` SHALL riferirsi a funzionalità e modelli realmente disponibili.

#### Scenario: i pulsanti del composer rispondono
- **GIVEN** un topic chat aperto
- **WHEN** l'utente usa attach, plan mode, fast mode, context ring, provider/model picker,
  mic, overflow (slash-command + voice) e il pulsante unificato send/queue/stop
- **THEN** ciascuno esegue la sua azione senza errori
- **AND** nessuna slash-command punta a una feature rimossa

### Requirement: FAST-MODE-01 — The ⚡ toggle sits in the composer's left cluster and flips on click

The chat composer SHALL render a Fast Mode toggle (`data-testid="chat-input-fast-mode"`)
between the `+` add menu and the context ring, starting OFF, flipping `aria-pressed`
on each click and carrying an amber background token (`bg-amber-500/10`) while ON. The
button exists only when the providers snapshot reports Fast Mode with no blocking
`reason`.

> Written from the test; the chat-fast-mode proposal said the order was
> Attach → Plan mode → Fast mode → Context ring. The shipped row is
> `+` menu → Fast mode → Context ring: the Plan toggle was removed (planning is an
> autonomy level, not a prompt flag) and the paperclip moved inside the `+` menu.

#### Scenario: The toggle renders in order and flips
- **GIVEN** a topic chat is open and the providers snapshot reports fast mode as available (`reason: null`)
- **WHEN** the composer renders
- **THEN** the `+` add menu, the fast-mode button and the context ring are all visible, left to right in that order
- **AND** no "toggle plan mode" button and no "Attach file" button exist in the row
- **AND** the fast-mode button has `aria-pressed="false"`
- **WHEN** the user clicks the fast-mode button
- **THEN** `aria-pressed` becomes `"true"` and the button's class list contains `bg-amber-500/10`
- **WHEN** the user clicks it again
- **THEN** `aria-pressed` returns to `"false"`

### Requirement: FAST-MODE-02 — A message sent with Fast ON carries `fastMode: true`

The system SHALL include `fastMode: true` in the body of the `POST /api/chat` request
issued for a message sent while the toggle is ON.

#### Scenario: The flag reaches the chat request
- **GIVEN** a topic chat is open with fast mode available
- **WHEN** the user turns the fast-mode toggle ON and sends a message
- **THEN** the `POST /api/chat` body carries `fastMode: true`
- **AND** it does not carry a truthy `planMode`

### Requirement: FAST-MODE-03 — Fast and planning coexist, and planning does not travel as a client flag

The system SHALL allow Fast Mode to be ON while the composer's autonomy level selects
planning, and the client SHALL NOT send a `planMode` field: the plan is applied
server-side from the autonomy level (`planModeFor`), not from a per-turn prompt flag.

> Written from the test; the chat-fast-mode proposal said the request would carry both
> `planMode: true` AND `fastMode: true`. The shipped request carries `fastMode` only.

#### Scenario: Autonomy set to ask, Fast ON, one flag on the wire
- **GIVEN** a topic chat is open with fast mode available
- **WHEN** the user sets the composer autonomy control to `ask`
- **AND** turns the fast-mode toggle ON and sends a message
- **THEN** the autonomy control reports `data-level="ask"`
- **AND** the `POST /api/chat` body carries `fastMode: true`
- **AND** the body has no `planMode` field at all

### Requirement: CCPROV-01 — Claude Code Provider Registration

> Promoted from `2026-05-16-claude-code-provider`; only the registration half is stated. The process-lifecycle scenarios of the original text (spawn flags, the 15-minute inactivity kill, the 2-hour max lifetime, SIGTERM then SIGKILL on stop) are exercised by unit tests under `server/providers/` that claim no requirement id, so they are not restated as scenarios here.

> Reread 27/08/2026 against the code, unchanged: the provider still declares those four capabilities and `GET /api/providers` still answers with the array, every entry carrying `name`, `connected` and `capabilities` (plus `isDefault`, which contradicts nothing).

The system SHALL register the Claude Code CLI as an AI provider named `claude-code`, declaring the capabilities `streaming`, `tools`, `sessions` and `abort`, and SHALL expose every registered provider over `GET /api/providers`.

#### Scenario: The providers endpoint lists the registered providers
- **GIVEN** the server has run provider initialisation
- **WHEN** a client issues `GET /api/providers`
- **THEN** the response SHALL carry a `providers` array with at least one entry
- **AND** every entry SHALL expose `name`, `connected` and `capabilities`

### Requirement: CCPROV-02 — Streamed Turns Render Text And Tool Cards

> Promoted from `2026-05-16-claude-code-provider`, rewritten from provider-callback wording to the visible end of the stream, which is what the covering tests assert. The original scenarios about `onTextDelta`/`onToolStart`/`onToolResult` fan-out, error propagation from the child process and per-session serialisation of concurrent messages live at unit level and are claimed by no test id.

> Reread 27/08/2026 against the code, and REWRITTEN twice. (a) The card shows a NORMALISED label, not the raw tool name: `Bash` reads `Shell`, an MCP tool reads `server · tool` (`buildToolDisplayLabel`, `client/src/components/Chat/toolDetail.ts`). (b) The card is not placed at the exact offset: the split moves to the nearest paragraph boundary, and the exact offset is used only when the text has no paragraph break (`client/src/components/MessageContent.tsx`).

The system SHALL render a streamed assistant turn incrementally: the assistant text as it arrives, and one tool card for every tool the turn uses. The card SHALL carry the tool's DISPLAY LABEL, which is the same word whatever CLI produced the call (`Bash` renders as `Shell`, an MCP tool as `server · tool`), and the raw name SHALL pass through when no label is known. The card SHALL be placed at the paragraph boundary nearest to the offset where the call happened, and at the exact offset when the text holds no paragraph break. A card SHALL render whether the call succeeded or failed, and a turn that uses several tools SHALL render one card per tool.

#### Scenario: A streamed turn renders its text and a card for the tool it used
- **GIVEN** an open topic with the message input ready
- **WHEN** the user sends a message and the turn streams back text plus a `Read` (or `Bash`) tool call
- **THEN** the assistant text SHALL appear in the message area
- **AND** a tool card SHALL appear alongside it, its `[data-testid="tool-call-name"]` carrying the label of that tool (`Read` for `Read`, `Shell` for `Bash`)

#### Scenario: A failed tool call still renders its card
- **GIVEN** a streamed turn whose tool call comes back as an error
- **WHEN** the turn is rendered
- **THEN** the assistant text SHALL appear
- **AND** the tool card SHALL still render with the tool's name

#### Scenario: Several tool calls in one turn each render a card
- **GIVEN** a streamed turn that uses `Grep` and then `Read`
- **WHEN** the turn is rendered
- **THEN** a card SHALL appear for each of the two tools
- **AND** the text that follows the calls SHALL appear after them

### Requirement: CCPROV-05 — Claude Code Provider Configuration

> Promoted from `2026-05-16-claude-code-provider`; the environment-defaults scenario was rewritten. It pinned `claude-sonnet-4-6` as the default model and the model list has since moved on (see CHAT-DEF-03), so no model id is stated here; the workspace scenarios state the resolution order that actually ships.

> Reread 27/08/2026 against the code, unchanged: the PATCH still writes the `provider` column and `GET /api/topics` reads it back, and the workspace still resolves a `ready` and existing worktree first, then the project path, then nothing. The resolution lives in `server/providers/claude-code.ts`, not in a file named after its own test.

The system SHALL let a topic select `claude-code` as its provider and SHALL persist that choice on the topic. The working directory of a Claude Code session SHALL be resolved from the topic: its bound worktree when that worktree is ready, otherwise the project checkout.

#### Scenario: A topic is switched to the claude-code provider
- **GIVEN** an existing topic
- **WHEN** the client issues `PATCH /api/topics/:id` with `{ provider: "claude-code" }`
- **THEN** `GET /api/topics` SHALL report that topic with `provider: "claude-code"`

#### Scenario: The session workspace follows the topic's binding
- **GIVEN** a topic bound to a project checkout
- **WHEN** the workspace for its session is resolved
- **THEN** the workspace SHALL be the project checkout
- **AND** a `ready` worktree bound to the topic SHALL win over the project path
- **AND** a pending or errored worktree SHALL fall through to the project path

#### Scenario: A topic with no usable project directory yields no workspace
- **GIVEN** a topic whose project directory does not exist, or a topic with no project at all
- **WHEN** the workspace for its session is resolved
- **THEN** the resolution SHALL yield nothing
- **AND** the caller SHALL fall back to the home directory rather than spawn in a dead cwd

### Requirement: CHAT-COMPOSER-01 - Removing one attachment out of several does not SEND the message

The composer is a `<form onSubmit>`, and inside a form a `<button>` with no `type`
IS a submit button. The little "x" on an attachment chip SHALL declare
`type="button"`: without it, a click that only tidies the tray submits the draft
with the wrong attachment set.

The obvious round - one attachment, click its x - CANNOT see the defect: the
handler drops the file, React re-renders before the browser runs the button's
submit step, and the chip has already left the DOM, so it has no form owner and
nothing is submitted. The bench SHALL therefore start from TWO attachments, where
the chips are keyed by index and the clicked button is still inside the form when
the submit step runs.

Both chip flavours SHALL be covered, because they are two components: the
paperclip chip and the image thumbnail.

#### Scenario: The x on the first of two attachments
- **GIVEN** a composer holding two attachments
- **WHEN** the x of the first one is clicked
- **THEN** the attachment SHALL be removed
- **AND** no message SHALL be sent, and no upload or chat request SHALL leave

### Requirement: CHAT-RND-01 — Syntax Highlighting In Code Blocks

> Promoted from `2026-07-10-chat-rendering-parity` and translated into English. The safe-degradation scenario (unknown language, blocks over 50 000 characters, tokenizer failure) is not restated: no test exercises it. The behaviour is in `highlightCode`, which returns null in those cases and leaves the block plain.

> Reread 27/08/2026 against the code, and NARROWED: two more cases ship plain, and neither was stated. The line-numbers view renders per row and stays plain by construction, and while a block is still streaming the tokenizer is fed a deferred copy, so the block renders plain until the deferred text catches up with the live one (`client/src/components/MessageContent.tsx`).

Code blocks in messages whose fence names a known language SHALL be rendered with syntax highlighting. Highlighting SHALL degrade to plain text, never to an error or to a stale snapshot, in the cases where it cannot hold: unknown language, oversize block, tokenizer failure, the line-numbers view, and the interval while a streaming block's deferred copy trails the text on screen.

#### Scenario: A javascript fence is tokenised
- **GIVEN** an assistant message containing a fence marked `javascript` with a keyword and a comment
- **WHEN** the message is rendered
- **THEN** the code block SHALL contain distinct token elements for the keyword and for the comment

### Requirement: CHAT-CONV-01 — Regenerate As A Sibling Branch

> Promoted from `2026-07-11-chat-conversation-pack` and translated into English. The "regenerate is not offered during streaming" scenario was rewritten: what ships is a per-message guard (the action is absent on a partial message) plus a 409 from the endpoint, and no test claims the streaming case, so only the offered-on-a-completed-message half is stated.

> Reread 27/08/2026 against the code, unchanged: the endpoint still forks a sibling under the anchor, truncates the prompt there, refuses a non-assistant message with 400 and a live stream with 409, and the action is still hidden on a partial message. Since then the prompt also carries the measurements of the turn being replaced (`CHAT-CONV-04`), which adds to this text and does not contradict it.

The system SHALL offer Regenerate on any completed assistant reply, not only on failed ones. Regenerating SHALL fork a new assistant sibling under the same anchor user message, leaving the previous reply reachable through the branch arrows, and SHALL truncate the prompt sent to the provider at the anchor so the model never sees the answer it is replacing. The endpoint SHALL refuse anything that is not an assistant message.

#### Scenario: The regenerate action is offered on a completed assistant reply
- **GIVEN** a topic whose thread ends in a completed assistant reply
- **WHEN** the user hovers that message
- **THEN** the message toolbar SHALL offer the regenerate action

#### Scenario: A regenerated reply becomes the active sibling
- **GIVEN** an assistant reply already exists under a user message
- **WHEN** a second assistant reply is forked under the same parent
- **THEN** it SHALL take the next branch index
- **AND** it SHALL become the active branch, the earlier reply staying reachable

#### Scenario: Only assistant messages can be regenerated
- **GIVEN** a user message, or an id that no message has
- **WHEN** `POST /api/messages/:id/regenerate` is issued for it
- **THEN** the request SHALL be refused instead of starting a turn

### Requirement: CHAT-CONV-02 — Message Deletion Takes Its Subtree

> Promoted from `2026-07-11-chat-conversation-pack` and translated into English; the substance is unchanged.

> Reread 27/08/2026 against the code, unchanged: `DELETE /api/messages/:id` still runs subtree, dense renumbering and active-pointer repair in one transaction and returns the active thread, and the button still arms before it deletes.

The system SHALL let the user delete a message. Deletion SHALL remove the whole descendant subtree, renumber the surviving siblings densely and repair the active-branch pointer, returning the resulting active thread. The UI SHALL require a two-click confirmation, and the removal SHALL be server truth.

#### Scenario: Delete with confirmation, and it survives a reload
- **GIVEN** a thread with a user question and the assistant reply under it
- **WHEN** the user clicks Delete on the reply and clicks the armed button again
- **THEN** the reply SHALL disappear from the thread
- **AND** after a full page reload the question SHALL still be there and the reply SHALL NOT

#### Scenario: Deleting a message takes its descendants with it
- **GIVEN** a message that has descendants
- **WHEN** it is deleted
- **THEN** the descendants SHALL be removed as well
- **AND** the response SHALL carry the shortened active thread

#### Scenario: Deleting a sibling renumbers the survivors densely
- **GIVEN** a parent with several sibling branches
- **WHEN** one sibling is deleted
- **THEN** the surviving siblings SHALL be renumbered without gaps
- **AND** the active-branch pointer SHALL be repaired to a branch that still exists

### Requirement: CHAT-CONV-03 — Conversation Export

> Promoted from `2026-07-11-chat-conversation-pack` and translated into English; the promise of roles and timestamps in the exported file was narrowed to the message contents, which is what the covering test reads back.

> Reread 27/08/2026 against the code, and WIDENED back: the promotion note narrowed the promise to the message contents because that is all the covering test reads back, but the exported file does carry a heading per message with the role and the local timestamp, and the topic name as its title. A requirement that promises less than the code does leaves the rest free to disappear unnoticed. The entry is offered only when the thread has at least one message.

The system SHALL export the active thread as a downloadable Markdown file from the composer's tools menu, when that thread holds at least one message. The file SHALL open with the topic name and SHALL carry, for every message of the active thread, a heading naming the author (the person or the assistant) with the message's timestamp, followed by its content.

#### Scenario: Export downloads a markdown file carrying the thread
- **GIVEN** a topic with messages
- **WHEN** the user opens the composer's tools menu and chooses Export conversation
- **THEN** a file whose name ends in `.md` SHALL be downloaded
- **AND** its content SHALL contain the messages of the active thread, each under a heading naming its author

### Requirement: REAL-TC-01 — Tool Calls Stored In History Render As Cards

> Promoted from `2026-05-16-real-e2e-tool-calls-and-media`; the test ids were corrected against what ships. The row is `[data-testid="tool-call-row-<id>"]` (the change said `tool-call-<id>`), and the error status is an attribute on that row, `data-status="error"`, not a separate `[data-testid="tool-call-status"]` element.

> Reread 27/08/2026 against the code, unchanged: `tool-call-row-<id>`, `tool-call-name`, `tool-call-args`, `tool-call-result`, `tool-call-error` and `data-status` all still ship, and the rows are still sorted by content offset. `Read` is one of the tools whose label equals its name, so the scenario below stays literal (see `CCPROV-02` for the tools where it does not).

The system SHALL render a tool card for every tool call stored on a message, when that message is loaded from chat history.

#### Scenario: A stored tool call renders a row carrying the tool name
- **GIVEN** a message in the database with a tool call `{ name: "Read", args: { path: "/src/app.ts" }, status: "success" }`
- **WHEN** the user opens the topic holding that message
- **THEN** a `[data-testid="tool-call-row-<id>"]` element SHALL be visible
- **AND** its `[data-testid="tool-call-name"]` SHALL contain "Read"

#### Scenario: The card expands to show arguments and result
- **WHEN** a rendered tool-call row is clicked
- **THEN** a `[data-testid="tool-call-args"]` element SHALL show the call's arguments
- **AND** a `[data-testid="tool-call-result"]` element SHALL show the call's result

#### Scenario: A failed tool call renders with the error status
- **GIVEN** a stored tool call with `status: "error"` and `error: "Permission denied"`
- **WHEN** the message is loaded
- **THEN** its row SHALL carry `data-status="error"`
- **AND** expanding it SHALL show `[data-testid="tool-call-error"]` containing "Permission denied"

#### Scenario: Several tool calls on one message render in offset order
- **GIVEN** a message with three tool calls at content offsets 0, 50 and 120
- **WHEN** the message is loaded
- **THEN** three tool-call rows SHALL be visible
- **AND** they SHALL appear top to bottom in the order of their content offsets

### Requirement: REAL-TC-02 — Media Stored In History Renders

> Promoted from `2026-05-16-real-e2e-tool-calls-and-media` unchanged: the element ids in the original text are the ones that ship.

> Reread 27/08/2026 against the code, unchanged: `media-image` with its `src`, `media-file` and `media-file-name` are still the ids that ship.

The system SHALL render a media component for every path stored in a message's `media`, when that message is loaded from chat history.

#### Scenario: An image path renders as a media image
- **GIVEN** a message in the database with `media: ["/uploads/test-screenshot.png"]`
- **WHEN** the user opens the topic holding that message
- **THEN** a `[data-testid="media-image"]` element SHALL be visible
- **AND** its `src` SHALL contain the media path

#### Scenario: A file path renders as a named media file
- **GIVEN** a message in the database with `media: ["/uploads/test-report.pdf"]`
- **WHEN** the message is loaded
- **THEN** a `[data-testid="media-file"]` element SHALL be visible
- **AND** a `[data-testid="media-file-name"]` element SHALL contain "test-report.pdf"

### Requirement: REAL-TC-03 — Live Streaming Produces Visible Tool Cards

> Promoted from `2026-05-16-real-e2e-tool-calls-and-media`; the selector was corrected to the shipped prefix `tool-call-row-`.

> Reread 27/08/2026 against the code, unchanged: the check still waits 30 seconds for a `tool-call-row-` element with a non-empty name, and still skips with the annotation "Gateway unavailable" instead of failing.

When a live chat turn uses a tool, the system SHALL render the tool card in real time through the whole unmocked pipeline (server stream to client state to DOM).

#### Scenario: A live turn that uses a tool shows the card
- **GIVEN** the gateway or AI service is available
- **WHEN** the user sends a message that makes the model use a tool
- **THEN** within 30 seconds at least one `[data-testid^="tool-call-row-"]` element SHALL appear in the message area
- **AND** its `[data-testid="tool-call-name"]` SHALL NOT be empty

#### Scenario: The check skips when the gateway is unavailable
- **GIVEN** the gateway or AI service is NOT available
- **WHEN** the live tool-call check runs
- **THEN** it SHALL skip with the annotation "Gateway unavailable"
- **AND** SHALL NOT report a failure

### Requirement: MONITOR-01 — An armed Monitor reads as an open watch, not a finished tool call

Claude Code's `Monitor` tool returns immediately — its result is the receipt of the arming (`Monitor started (task …)`), not the outcome of the watch — and the turn closes a moment later. The system SHALL render that tool call as a watch that is STILL OPEN: naming what is under watch, saying the outcome will arrive as a separate message, and dropping that claim once an outcome is attached.

> Companion requirements: `MONITOR-02` (the turn the CLI opens by itself), `MONITOR-03` (where that answer lands), `MONITOR-04` in `claude-sessions` (the session phase while a watch is armed).

#### Scenario: A Monitor invocation derives a monitor tool detail
- **GIVEN** a `Monitor` tool call whose input carries `description`, `ws.url` and `persistent: true`
- **WHEN** the tool detail is derived from the tool name and input
- **THEN** the detail type SHALL be `monitor`
- **AND** it SHALL carry the description, the websocket url and the persistent flag
- **AND** a `Monitor` armed with a `command` and no `ws` SHALL carry that command as its source instead

#### Scenario: An armed card says it is listening and that the answer arrives by itself
- **GIVEN** a Monitor card with a description and no result, rendered during a live turn
- **WHEN** the card renders
- **THEN** it SHALL state that it is listening
- **AND** it SHALL state that the outcome will arrive as a new message
- **AND** the description of what is under watch SHALL remain visible

#### Scenario: A delivered outcome closes the watch
- **GIVEN** a Monitor card whose tool result carries a delivered outcome
- **WHEN** the card renders
- **THEN** it SHALL NOT claim to be listening
- **AND** it SHALL show the outcome

#### Scenario: The pulse belongs to a live turn only
- **GIVEN** a Monitor card rendered while the turn is in flight
- **WHEN** the card renders
- **THEN** the status dot SHALL pulse
- **AND** the same card rendered with no turn in flight SHALL still state that it is listening but SHALL NOT pulse

### Requirement: MONITOR-02 — A turn the CLI opens by itself is adopted, not dropped

An armed `Monitor` does not deliver its event inside the turn that armed it: that turn ended at its `result`, and after a `result` nobody is listening to the session, so every event of the delivery fell one by one. The system SHALL recognise a turn opened with no listener, wake exactly one adoption for it, hold the events that arrive while the adoption is being set up, and deliver them in order to whoever adopts.

#### Scenario: Content with nobody listening is a turn nobody asked for
- **GIVEN** a stream line whose kind is `content` or `partial`, no stream handler is registered, and no replay is in progress
- **WHEN** the line is classified
- **THEN** it SHALL be treated as the start of a woken turn

#### Scenario: A closing line, noise and compaction do not open a turn
- **GIVEN** the same conditions but a line of kind `result`, `noise`, `compaction` or `unknown`
- **WHEN** the line is classified
- **THEN** it SHALL NOT be treated as a woken turn

#### Scenario: A live handler means the turn was asked for
- **GIVEN** a content line while a stream handler is already registered
- **WHEN** the line is classified
- **THEN** it SHALL NOT be treated as a woken turn
- **AND** the events SHALL reach the registered handler as any ordinary turn

#### Scenario: A re-adoption replay wakes nothing
- **GIVEN** a content line arriving during a replay scan (`replayMute` or `replaySilent`), which deliberately re-reads turns that already finished
- **WHEN** the line is classified
- **THEN** it SHALL NOT be treated as a woken turn, so a server restart never rewrites yesterday's answer into the chat

#### Scenario: A background agent's line opens no turn
- **GIVEN** a turn that ended with an Agent still running in the background, whose lines keep arriving with `parent_tool_use_id` and no handler registered
- **WHEN** those lines are classified, live or in the reattach scan of the broker store
- **THEN** they SHALL NOT open a woken turn, and SHALL NOT make the store tail read as a turn in flight
- **AND** the CLI's own wake, which starts on a line of the model, SHALL still be adopted, with any agent line that arrives while it is held delivered to it in order
- **AND** the session's process SHALL NOT be reaped, killed for a config change or recycled by the lifetime cap while that background work is alive (two hours without news of it presume it lost), nor reaped at boot, and SHALL stay attached so its wake is heard; a config change it could not take SHALL be applied at the next send that finds it idle

#### Scenario: The wake fires once per turn, not once per event
- **GIVEN** a session with no handler
- **WHEN** three successive assistant content events arrive
- **THEN** the wake SHALL be called exactly once for that session

#### Scenario: Events held during adoption are delivered in order
- **GIVEN** a woken turn whose adoption has not completed yet, and text, a tool use and more text arriving meanwhile
- **WHEN** a handler adopts the turn
- **THEN** all held events SHALL be delivered to it, in arrival order
- **AND** the adopted turn SHALL then close normally: its `result` reaches `onDone` and the handler is released

#### Scenario: Adopting with one's own handler already registered succeeds
- **GIVEN** an adopter that registered its stream handler just before adopting, as the route does
- **WHEN** it adopts the woken turn
- **THEN** the adoption SHALL succeed
- **AND** the held events SHALL be delivered to it exactly once

#### Scenario: Adopting a session somebody else drives, or a dead one, is refused
- **GIVEN** a woken turn whose session is already driven by another handler
- **WHEN** a second handler tries to adopt
- **THEN** the adoption SHALL be refused, the incumbent handler SHALL stay in place, and the challenger SHALL receive no events
- **AND** adopting a session whose process is no longer alive SHALL likewise be refused

#### Scenario: With no observer registered nothing breaks
- **GIVEN** no wake observer is armed at all
- **WHEN** a content event arrives on a session with no handler
- **THEN** handling SHALL NOT throw and no handler SHALL be installed

### Requirement: MONITOR-03 — The woken answer lands in chat as its own row, marked as unrequested

The answer produced by a woken turn SHALL be written to the conversation as a row of its own, carrying a banner that says the user did not ask for it and what was under watch — and a woken turn with nothing to say SHALL leave no row at all.

#### Scenario: The answer is written to its own finished row
- **GIVEN** a topic whose provider supports adoption
- **WHEN** `POST /api/chat` is called with `mode: "woken"` and the adopted turn streams text and completes
- **THEN** the response SHALL be a 200 stream
- **AND** exactly one assistant row SHALL hold that text, not marked partial

#### Scenario: The woken row does not inherit the previous turn
- **GIVEN** a conversation whose last assistant row already holds a tool call and text
- **WHEN** a woken turn is adopted and produces its own text
- **THEN** the previous row SHALL stay exactly as it was
- **AND** the new row SHALL hold only its own content, with nothing of the previous turn merged into it

#### Scenario: A woken turn with nothing to say leaves no row
- **GIVEN** a woken turn whose only output is the CLI's no-content sentinel
- **WHEN** the turn completes
- **THEN** the number of rows in the conversation SHALL be unchanged

#### Scenario: No user message is fabricated to start the turn
- **GIVEN** a woken turn adopted with an empty message list
- **WHEN** the turn completes
- **THEN** no user row SHALL exist for that session
- **AND** the provider's ordinary send path SHALL NOT be called

#### Scenario: A turn no longer adoptable leaves nothing behind, and no error banner
- **GIVEN** a session that stopped being adoptable between the wake and the call — the user wrote in the meantime, or the child died
- **WHEN** the woken request is served
- **THEN** the response SHALL still be a 200 stream, the failure travelling on the wire rather than as an HTTP code
- **AND** no partial assistant row SHALL be left for the next re-adoption to reuse
- **AND** no failure notice SHALL be written into the conversation, because the real answer is arriving on the other turn

#### Scenario: A provider that cannot adopt is refused, never redirected to a normal send
- **GIVEN** a topic bound to a provider with no adoption support
- **WHEN** `POST /api/chat` is called with `mode: "woken"`
- **THEN** the response SHALL be `501` with code `woken_unsupported`
- **AND** the conversation SHALL be left untouched

#### Scenario: The banner says where the answer came from
- **GIVEN** an assistant row whose blocks open with a `woken` block carrying a label
- **WHEN** the message renders
- **THEN** a woken banner SHALL be shown carrying that label
- **AND** the body of the answer SHALL render below it

#### Scenario: The source is the CLI's own notification, never the Monitor armed last
- **GIVEN** a turn the CLI opened by itself, whose stdout names no source (a Monitor's event prints no line: 0 of 7 events of chat 33966f4e on 30/09, CLI 2.1.285)
- **WHEN** the wake is adopted
- **THEN** its source SHALL be read from the `<task-notification>` lines the CLI wrote to its own transcript since the previous turn ended (`server/providers/claude/wake-source.ts`, the transcript found from the cwd and session id of the CLI's last `system/init`), one `woken` block per notification: a Monitor's event as `{source: "monitor", label: <its description>, text: <the event>}`, a Monitor's end as `{source: "monitor", label: <its description>, end: <how it ended>, text: <its last event>}`, a background task's report as `{source: "task", label: <its summary>}`
- **AND** a Monitor's end SHALL be recognised by the four summaries the CLI writes for it (`Monitor "<description>" stream ended`, `... script failed` and `... ended without producing output`, each possibly followed by ` (exit N)`, and `... stopped`; CLI 2.1.286), not read as a task's report: recorded with the real CLI 2.1.285, the end of a Monitor carries its last event in that same notification (`<summary>Monitor "probe-mon" stream ended</summary>` + `<event>EVT-TWO</event>`), and 7 Monitor notifications of 43 in a real chat had that shape (`server/providers/claude/wake-source.test.ts`). The stdout fallback SHALL name such an end the same way, without an event
- **AND** with no transcript line, the source SHALL be the task whose `task_notification` stdout printed before the wake, if any; otherwise the banner SHALL carry no label
- **AND** the source SHALL NOT be the description of the Monitor armed last: that guess named the wrong source on 7 wakes of 9 in the replay of 33966f4e (`server/providers/claude-code-monitor-visibility.test.ts`)
- **AND** a source SHALL name one wake only: a report or a notification already used is not read again for the next wake

#### Scenario: A Monitor's event reads as that Monitor's event
- **GIVEN** a `woken` block with `source: "monitor"`, a label and an event text
- **WHEN** the message renders
- **THEN** the banner SHALL say it is that Monitor's event (`woken.monitorEvent`), with the Monitor tool's icon, and SHALL show the event's text (`data-testid="woken-event"`)
- **AND** a `source: "monitor"` block with an `end` SHALL say that Monitor ended and how (`woken.monitorEnded`), with its last event's text
- **AND** a `source: "task"` block SHALL read as a background task's report (`woken.taskReport`), and a row with several `woken` blocks SHALL show one banner each
- **AND** the banner SHALL show live, in every window, without a reload: `stream:start` of a woken turn carries its `woken` blocks as `banners` and the placeholder opens with them, and a history answer read before the turn ended here SHALL NOT drop them from the bubble the end closed (`withServerBanners`, `client/src/hooks/reconcileMessages.ts`). Measured 01/10 on `chat-monitor-visible.spec.ts`: without both, 3 runs of 5 had the row right in the database and no banner on screen until a reload

#### Scenario: A banner with no label still declares the provenance
- **GIVEN** a `woken` block with no label
- **WHEN** the message renders
- **THEN** the banner SHALL still be shown, stating that the answer was not requested

#### Scenario: The banner appears once, and only on woken rows
- **GIVEN** an ordinary assistant message with no `woken` block
- **WHEN** it renders
- **THEN** no banner SHALL appear
- **AND** on a woken row the label SHALL appear exactly once, the banner being rendered above the bubble and skipped in the block timeline

### Requirement: BGSHELL-01 — A background shell is recognised from the CLI's own answer

`Bash(run_in_background: true)`, `BashOutput` and `KillShell` are answered by the CLI in prose and tags, not in a structured field. The system SHALL read those answers permissively and SHALL return nothing rather than guess: an unrecognised shell stays invisible, while a wrongly recognised one would aim a Stop button at something else.

> Companion requirements: `BGSHELL-03` (the live card), and in `processes`: `BGSHELL-02` (the registry) and `BGSHELL-04` (the orphan sweep).

#### Scenario: The id is read from the sentence the CLI actually writes
- **GIVEN** a background `Bash` result reading `Command running in background with ID: bash_1`
- **WHEN** the id is parsed
- **THEN** it SHALL be `bash_1`
- **AND** a JSON form carrying `shell_id` or `bash_id` SHALL be read too
- **AND** a bare `bash_42` with no label SHALL be read as a last resort

#### Scenario: No id is invented from nothing
- **GIVEN** an empty, missing or unrelated result
- **WHEN** the id is parsed
- **THEN** the result SHALL be null, on the server, and undefined in the card's own stricter parse

#### Scenario: The reported status is read, and a non-zero exit outranks the label
- **GIVEN** a `BashOutput` result carrying `<status>` and optionally `<exit_code>`
- **WHEN** the status is parsed
- **THEN** `running` and `in_progress` SHALL read as running; `killed` and `terminated` as killed; `failed` and `error` as failed
- **AND** `completed` with a non-zero exit code SHALL read as FAILED, because the code says what the label does not

#### Scenario: Silence is not a finished shell
- **GIVEN** a result that says nothing about status, or an unknown status word
- **WHEN** the status is parsed
- **THEN** the result SHALL be null, so the caller keeps what it already knew instead of inventing a completion

#### Scenario: The output shown is what the shell printed
- **GIVEN** a `BashOutput` result mixing `<status>`, `<timestamp>`, `<stdout>` and `<stderr>`
- **WHEN** the output is extracted
- **THEN** the metadata tags and their contents SHALL be gone
- **AND** both channels SHALL be unwrapped into plain lines
- **AND** a result with no tags at all SHALL pass through unchanged

#### Scenario: The three shell tools derive their own details
- **GIVEN** a `Bash` invocation with `run_in_background: true`, a `BashOutput` carrying `bash_id`, and `KillShell`/`KillBash`/`kill_shell`
- **WHEN** their tool details are derived
- **THEN** the Bash detail SHALL carry a `background` flag, absent on a foreground Bash
- **AND** the `BashOutput` detail SHALL be of type `bash_output` carrying the shell id
- **AND** all the kill spellings SHALL be of type `kill_shell` carrying the shell id

### Requirement: BGSHELL-03 — The chat card of a background shell is live, not a memory

A background shell is not a tool that finished: it is a process that stays. The card SHALL follow it in the process registry and change on its own — new output, then the exit code — without the page being reloaded, and SHALL fall back to the static transcript text when the shell cannot be identified.

#### Scenario: The card finds its own shell, never another chat's
- **GIVEN** two sessions that each named their first shell `bash_1`
- **WHEN** the card looks its shell up with its session key and id
- **THEN** it SHALL match the entry whose process key combines BOTH
- **AND** with no session key and two candidates it SHALL match nothing, preferring a mute card to another chat's output
- **AND** with a session key that matches no entry it SHALL match nothing rather than fall back to the id alone
- **AND** with no session key and a single candidate it SHALL match that one
- **AND** at equal key the running entry SHALL win over the finished one
- **AND** entries that are not shells, and a lookup with no shell id, SHALL match nothing

#### Scenario: Output arrives in the card while the page sits still
- **GIVEN** a topic whose transcript holds a background `Bash` card, and a shell alive in the registry before the chat is opened
- **WHEN** the row is opened and the registry is then moved three times with no further action on the page
- **THEN** the live status SHALL read `running`
- **AND** each new chunk of output SHALL appear in the card's tail
- **AND** the earlier output SHALL still be there: the tail accumulates rather than being replaced

#### Scenario: The card says how it ended instead of staying in progress
- **GIVEN** the same live card
- **WHEN** the shell is moved to a failed status with exit code 1
- **THEN** the live status SHALL read `ended`
- **AND** the card SHALL show the exit code

### Requirement: SUBAGENT-01 — A sub-agent's own work is logged onto the parent Task call

Sub-agent (`Task` tool) events arrive on the SAME stream as the parent, marked by `parent_tool_use_id`. The system SHALL flatten each invocation into a growing action log on the parent call — one row per child emission — rather than attributing the child's tools to the parent or dropping them.

> `CHAT-02` covers how the sub-agent CARD renders. This requirement covers what the card is fed.

#### Scenario: An unknown parent is inert
- **GIVEN** a tracker with no parent registered for a given tool-use id
- **WHEN** it is asked about that id, or child text, tool use or tool result are recorded against it
- **THEN** every call SHALL report nothing, and no state SHALL be created

#### Scenario: A registered parent captures what it spawned
- **GIVEN** a `Task` invocation carrying `subagent_type` and `description`
- **WHEN** the parent is registered
- **THEN** the snapshot SHALL carry both, with an empty action list, empty text and not finished
- **AND** registering the same id again SHALL NOT overwrite what was captured first

#### Scenario: Child text accumulates and is logged
- **GIVEN** a registered parent
- **WHEN** the sub-agent emits assistant text
- **THEN** the text SHALL be appended to the parent's accumulated text
- **AND** a `text` action SHALL be appended to the log

#### Scenario: A child tool call is summarised by its most informative input
- **GIVEN** a child tool use
- **WHEN** it is recorded
- **THEN** the action SHALL carry the tool name and a summary drawn from the input — the command, the file path, the pattern, the query, the url, the description — and an MCP tool name with no usable input SHALL fall back to its namespace
- **AND** the action SHALL start as running

#### Scenario: A child tool result patches its own action
- **GIVEN** a recorded child tool use
- **WHEN** its result arrives
- **THEN** the matching action SHALL move to success, or to error when the result is flagged as one
- **AND** the first line of the result SHALL be appended to that action's summary when there is room
- **AND** a result whose child id was never registered SHALL be a no-op

#### Scenario: The log is bounded and the snapshot is safe to hold
- **GIVEN** a sub-agent that keeps emitting
- **WHEN** the log passes 200 actions, or a summary passes 160 characters
- **THEN** the log SHALL stay bounded and the summary SHALL be truncated with an ellipsis
- **AND** a snapshot SHALL be a copy: mutating it SHALL NOT change the tracker's state

#### Scenario: Finishing, deleting and clearing
- **GIVEN** a registered parent
- **WHEN** it is finished with a final result
- **THEN** the returned snapshot SHALL be marked finished, using the final result as its text when the sub-agent produced none
- **AND** finishing an unknown parent SHALL report nothing
- **AND** deleting a parent SHALL drop its child mappings too, and clearing SHALL wipe everything

#### Scenario: The still-running parents can be listed
- **GIVEN** several registered parents
- **WHEN** the pending list is read — the keep-alive loop's only input
- **THEN** it SHALL name the registered parents that are not finished
- **AND** SHALL exclude the finished and the deleted ones
- **AND** an empty tracker SHALL yield an empty list

### Requirement: SUBAGENT-02 — A burst of sub-agent activity is coalesced, and the final state still arrives

Each sub-agent action used to trigger a deep copy, a database write and a broadcast of the WHOLE action list — quadratic in something the user sees as a list growing. Because the payload is a snapshot and the renderer collapses by call id, intermediate frames are discardable; the last one, and any finished one, are not.

#### Scenario: A burst does not produce one send per action
- **GIVEN** a sub-agent emitting fifty actions in a tight loop
- **WHEN** each one asks for an update
- **THEN** a single update SHALL leave, the rest collapsing into one queued send
- **AND** that frame SHALL carry real actions, not an empty list

#### Scenario: The last state always lands
- **GIVEN** a first burst that sends immediately and a second that is queued
- **WHEN** the coalescing window elapses
- **THEN** the last update SHALL carry the full count of actions recorded by then

#### Scenario: The snapshot is taken when the frame is sent, not when it is queued
- **GIVEN** an update queued while one action exists and four more recorded before the window elapses
- **WHEN** the queued frame leaves
- **THEN** it SHALL carry all five, so no stale state is broadcast and no skipped frame is ever copied

#### Scenario: A finished sub-agent skips the window and leaves nothing behind
- **GIVEN** a sub-agent marked finished
- **WHEN** its update is emitted
- **THEN** it SHALL be sent immediately rather than waiting for the window, carrying the finished flag
- **AND** the per-parent coalescing slot SHALL be forgotten, so no timer survives the sub-agent

### Requirement: SUBAGENT-04 — A sub-agent that exits reports its real result to the chat that delegated

A sub-agent spawned from a topic chat reports its end into that conversation, so the chat that promised an update reaches an end instead of hanging on a promise nobody can keep. The end is classified from the child's own transcript into a status: `completed` (its turn closed with `end_turn`), `failed` (an API error record, or a PTY that died mid-turn), `stopped` (stopped by its parent, its tab closed, or swept), `undelivered` (its transcript holds no prompt) or `lost` (its terminal did not survive a restart). Only a `completed` body is the child's own words; every other status SHALL be named with its reason, and SHALL NOT read as a clean but silent finish. Every way a child ends SHALL be reported: the bridge's exit frame, `stop_agent`, a closed tab, the orphan sweep, and a restart that found no PTY; a Reload of the child's tab is not an end.

#### Scenario: The child's own words are the body
- **GIVEN** a `completed` outcome carrying the child's final assistant text
- **WHEN** the body is formatted
- **THEN** it SHALL be that text, trimmed

#### Scenario: A failure names its reason
- **GIVEN** a `failed` outcome with a non-zero exit code, or an API error line such as a spend limit
- **WHEN** the body is formatted
- **THEN** it SHALL be an italic note naming the failure and that reason

#### Scenario: A prompt that never arrived is not called a silent finish
- **GIVEN** a child whose transcript holds only its start-up records
- **WHEN** it ends and the body is formatted
- **THEN** it SHALL say that the task never reached the sub-agent

#### Scenario: A stop mid-turn is marked partial
- **GIVEN** a child stopped while its turn was open, its last text a working sentence
- **WHEN** the body is formatted
- **THEN** it SHALL say it was stopped before its turn ended, and why
- **AND** it SHALL quote that text as the last line seen, not as the outcome

#### Scenario: A clean but silent finish gets the neutral note
- **GIVEN** a `completed` outcome whose final message holds no text
- **WHEN** the body is formatted
- **THEN** it SHALL be the neutral "finished with no output" note, not a failure

#### Scenario: The report names the sub-agent above its body
- **GIVEN** a formatted exit for a sub-agent whose parent named it
- **WHEN** the chat message is composed
- **THEN** it SHALL open with a bold header naming that sub-agent by that name, with the body below it and no emoji
- **AND** with no result the status note SHALL be embedded in the same shape

#### Scenario: The report names the branch when the child had one
- **GIVEN** an exit for a sub-agent that ran in a worktree of its own (WORKTREE-14)
- **WHEN** the chat message is composed
- **THEN** a closing line SHALL name that branch and how to read its commits
- **AND** an exit with no branch SHALL produce exactly the message it produces today

### Requirement: SUBAGENT-05 — The child's real transcript is found, not the one it was assigned

A sub-agent spawned as its own CLI does not honour the session id pre-assigned to it: it mints its own and writes the transcript under THAT name, so a read keyed by the assigned id finds no file and the parent is woken with an empty body. The system SHALL find the child's transcript by content, and SHALL prefer finding none to finding the parent's.

#### Scenario: The child is told apart from a parent sharing its working directory
- **GIVEN** a project directory holding both the parent's transcript, actively appended, and the child's
- **WHEN** the child's transcript is looked up by its working directory and the opening snippet of its spawn prompt
- **THEN** the child's own session id SHALL be returned, not the parent's newer file

#### Scenario: An isolated working directory needs no content match
- **GIVEN** a single recent transcript in a directory with no parent or sibling to confuse
- **WHEN** the lookup runs
- **THEN** that transcript SHALL be returned even without a content match
- **AND** with two or more recent files and no content match, nothing SHALL be returned rather than the parent's

#### Scenario: Time and working directory bound the match
- **GIVEN** a transcript older than the spawn beyond the tolerated skew
- **WHEN** the lookup runs
- **THEN** it SHALL be ignored
- **AND** a file stamped just before the spawn SHALL still be accepted, small negative clock skew being tolerated
- **AND** a content match whose recorded working directory differs from the spawn's SHALL be rejected

#### Scenario: A missing project directory is not an error
- **GIVEN** a project directory that does not exist
- **WHEN** the lookup runs
- **THEN** it SHALL return nothing

#### Scenario: The prompt fingerprint is stable
- **GIVEN** a spawn prompt with irregular whitespace and mixed case
- **WHEN** its snippet is normalised
- **THEN** whitespace SHALL be collapsed, the text lowercased and truncated to the fixed length the matcher compares against

### Requirement: SUBAGENT-06 — Each sub-agent completion is delivered to the parent chat exactly once

Gateway-side sub-agents announce their completion inside the PARENT session's transcript. The system SHALL watch that file incrementally and deliver each completion once — surviving a half-written line, a truncation, a rotation and a repeated announcement — and SHALL stop watching a session after its window elapses.

#### Scenario: The watch starts at the end of the file
- **GIVEN** a transcript that already holds a completion event
- **WHEN** the session starts being watched and a poll runs
- **THEN** nothing SHALL be delivered: history is not re-delivered

#### Scenario: A completion written after the watch began is delivered
- **GIVEN** a watched session
- **WHEN** a completion event is appended and a poll runs
- **THEN** one message SHALL be appended to that session carrying the child's result and its task
- **AND** the topic's unread count SHALL be bumped

#### Scenario: What has been read is not read again
- **GIVEN** a completion already delivered
- **WHEN** a second poll runs with nothing new
- **THEN** nothing further SHALL be delivered
- **AND** the SAME completion announced twice SHALL be delivered once, deduplicated by the child's session key

#### Scenario: A half-written last line is rewound
- **GIVEN** a poll that catches the last line mid-write
- **WHEN** the line is later completed
- **THEN** the delivery SHALL happen then, and not before

#### Scenario: Truncation and rotation restart the cursor
- **GIVEN** a transcript that shrinks below the cursor, or is replaced by a new file
- **WHEN** the next poll runs
- **THEN** reading SHALL restart from the beginning of the file rather than from a cursor that no longer means anything

#### Scenario: Lines that are not completions are ignored quietly
- **GIVEN** ordinary transcript lines
- **WHEN** a poll runs
- **THEN** nothing SHALL be delivered and no error SHALL be raised

#### Scenario: The watch is bounded and not duplicated
- **GIVEN** a watched session
- **WHEN** its watch window elapses
- **THEN** the session SHALL stop being watched
- **AND** asking to watch the same session twice SHALL NOT watch it twice

#### Scenario: The child's text is extracted from whatever shape it arrives in
- **GIVEN** a completion whose content is a plain string, or a list of blocks of which only some are text
- **WHEN** the text is extracted
- **THEN** a string SHALL pass through, a block list SHALL yield only its text blocks concatenated
- **AND** any other shape SHALL yield an empty string rather than throwing

### Requirement: SUBAGENT-07 — A sub-agent's exit report is its own row and does not swallow the live turn

The exit report is persisted and broadcast as an ordinary new message at once, while the PARENT's turn is still open: the parent usually stops its child from inside a turn, and a report held in memory until that turn closes is lost for good by a restart. The open turn writes its own row by id, so the report's row keeps its content when the turn ends. The client SHALL place it by identity — the id announced when the turn started — and never by position, so the report does not take over the live bubble and the rest of the answer keeps landing in its own.

#### Scenario: The report lands beside the live turn, which keeps filling
- **GIVEN** a turn that announced its id and has already streamed part of its text
- **WHEN** a persisted assistant message with a DIFFERENT id arrives
- **THEN** it SHALL appear as a second bubble, the live one keeping the text it already had
- **AND** the deltas that follow SHALL land in the live bubble, not appended to the report

#### Scenario: The row that CLOSES the turn merges into the live bubble
- **GIVEN** a window that received the turn's start but no content deltas — the case of a window not subscribed to the topic
- **WHEN** a persisted assistant message arrives carrying the turn's OWN id
- **THEN** it SHALL merge into the existing bubble, which SHALL then hold the full text
- **AND** exactly one assistant bubble SHALL exist, bearing that id

#### Scenario: A truncated preview does not shorten what the window already has
- **GIVEN** a bubble filled from the catch-up frame with the whole text of the turn
- **WHEN** a persisted message for that same id arrives carrying a shorter preview
- **THEN** the text already displayed SHALL NOT be shortened

#### Scenario: A report delivered under the parent's open turn is written at once and outlives that turn
- **GIVEN** a parent turn still streaming, from which the parent stops its child
- **WHEN** the child's end is reported
- **THEN** the report's row SHALL be in the database before the turn closes
- **AND** when the turn ends, the report's row SHALL keep its content and the turn's row SHALL hold the turn's text

### Requirement: SUBSTRIP-01 — A chat's sub-agent stays in its strip while it runs, and is marked ended when it ends

A sub-agent spawned by a chat (a terminal session whose `parentSessionKey` is that chat's sessionKey) SHALL keep its row in the chat's sub-agent strip for as long as its session is live, whatever is sent in the parent chat or typed into the sub-agent's terminal pane. When its session leaves the live roster (the process exits, is stopped or crashes) the row SHALL stay, marked ended with the "done" check, until the user dismisses it, closes its terminal tab, or the parent chat is archived; it SHALL survive a reload. The sub-agent's terminal tab, top-level or inside a project window, SHALL stay open while that row does, whether its session was parked or deleted, also across a reload. A sub-agent resumed from its pane SHALL be listed live again.

#### Scenario: A message in the parent chat does not take the sub-agent away
- **GIVEN** a chat with a live sub-agent listed in its strip and its terminal pane open
- **WHEN** the user sends a message in the chat
- **THEN** the strip row and the terminal pane SHALL still be there

#### Scenario: The sub-agent ends and is marked, not lost
- **GIVEN** a chat whose only sub-agent is live
- **WHEN** the sub-agent's process ends
- **THEN** the strip SHALL still show its row, marked ended
- **AND** the sub-agent's terminal pane SHALL stay open
- **AND** after a reload the ended row SHALL still be there, until the user dismisses it

### Requirement: SUBSTRIP-01b — Closing an ended sub-agent's tab takes its row away

Closing the terminal tab of an ended sub-agent SHALL remove its row from the chat's strip, by any close gesture (the tab's close button, the keyboard shortcut, the context menu, the sidebar, a tab inside a project), and the row SHALL NOT come back after a reload.

#### Scenario: The tab bar's close button dismisses the ended row
- **GIVEN** a chat whose sub-agent has ended and whose terminal pane is still open
- **WHEN** the user closes that terminal tab from the tab bar
- **THEN** the strip SHALL no longer show its row, also after a reload

### Requirement: SUBSTRIP-01c — Closing a live sub-agent's tab does not leave an ended row

Closing the terminal tab of a sub-agent that is still live SHALL remove its row, and the retirement of its session that follows SHALL NOT bring the row back marked ended. A dismissed sub-agent that is later resumed SHALL be listed again, and recorded as ended if it then ends.

#### Scenario: The retired session is not recorded as ended
- **GIVEN** a chat with a live sub-agent whose terminal pane is open
- **WHEN** the user closes that terminal tab and the server retires the session
- **THEN** the strip SHALL not show a row for it, also after a reload

### Requirement: SUBSTRIP-01e — A sub-agent's tab closed inside a project leaves no ended row

The close of a terminal tab inside a project window SHALL dismiss the sub-agent's row like a top-level close does (SUBSTRIP-01c): the session the project retires after its undo window SHALL NOT bring the row back marked ended.

#### Scenario: The tab closed inside a project, retired after the undo window
- **GIVEN** a project's chat whose live sub-agent's terminal pane is open in the project window
- **WHEN** the user closes that terminal tab from the project's tab bar and the session is retired once the undo window is over
- **THEN** the strip SHALL not show a row for it, also after a reload

### Requirement: SUBSTRIP-01f — Cmd+W on a sub-agent's tab takes its row away

In the desktop shell, closing the focused terminal tab of an ended sub-agent with Cmd+W SHALL remove its row from the chat's strip, as the tab's close button does (SUBSTRIP-01b).

#### Scenario: The keyboard shortcut dismisses the ended row
- **GIVEN** a chat whose sub-agent has ended and whose terminal tab is the focused one, in the desktop shell
- **WHEN** the user presses Cmd+W
- **THEN** the tab SHALL close and the strip SHALL no longer show its row, also after a reload

### Requirement: SUBSTRIP-01g — Inside a project, a stopped sub-agent's tab stays open with its ended row

Inside a project window, the terminal tab of a chat's sub-agent SHALL NOT be closed by the end of its session, also when the end deletes the session instead of parking it (the parent's `stop_agent`): it SHALL stay open, also across a reload, for as long as the chat's strip shows the sub-agent's row marked ended (SUBSTRIP-01), and dismissing that row SHALL close the tab with it.

#### Scenario: The parent stops the sub-agent whose tab is open in the project
- **GIVEN** a project's chat whose sub-agent's terminal tab is open in the project window
- **WHEN** the parent stops the sub-agent, which deletes its session instead of parking it
- **THEN** the tab SHALL stay open while the strip shows the row marked ended, also after a reload
- **AND** dismissing the row SHALL close the tab

### Requirement: SUBSTRIP-01h — A stopped sub-agent's top-level tab stays open

A top-level terminal tab of a chat's sub-agent SHALL NOT be closed by the end of its session, also when the end deletes the session instead of parking it: it SHALL stay open, also across a reload, while the chat's strip shows the sub-agent's row marked ended.

#### Scenario: The parent stops the sub-agent whose tab is open
- **GIVEN** a chat whose sub-agent's terminal tab is open as a top-level tab
- **WHEN** the parent stops the sub-agent, which deletes its session instead of parking it
- **THEN** the tab SHALL stay open while the strip shows the row marked ended, also after a reload

### Requirement: SUBSTRIP-01i — A sub-agent stopped while the app is closed keeps its project tab at the next launch

Inside a project window, the terminal tab of a chat's sub-agent whose session ended while no page of the app was open SHALL stay open at the next launch, with the chat's strip showing its row marked ended (SUBSTRIP-01g), also when the roster answers after the parked-sessions list.

#### Scenario: The parent stops the sub-agent while the app is closed
- **GIVEN** a project's chat whose live sub-agent's terminal tab is open in the project window
- **WHEN** the app is closed, the parent stops the sub-agent, and the app is opened again
- **THEN** the tab SHALL be open and the strip SHALL show the row marked ended, also after a further reload

### Requirement: SUBSTRIP-01d — A dismissal holds in every window of the browser

The ended rows and the dismissals SHALL be shared by every window of the same browser: a row dismissed in one window SHALL disappear from the others, and no window SHALL bring it back by writing its own older copy.

#### Scenario: Two windows dismiss one row each
- **GIVEN** two windows of the same browser showing the chat's ended sub-agents
- **WHEN** one window dismisses a row and the other then dismisses another
- **THEN** the first row SHALL disappear from the other window too, and neither row SHALL come back after a reload

### Requirement: TODO-01 — The session's latest todo list is the plan pinned above the composer

The system SHALL keep the most recent todo list written by the agent
(`TodoWrite`) available as a snapshot of the current plan: the items, how many
are completed, how many there are, and which one is in progress. "Most recent"
SHALL be read newest-first across the transcript AND newest-first within a single
message, since one message can carry several writes. A session with no todo, and
a latest list that is EMPTY, SHALL both pin nothing — an empty checklist is not a
plan worth showing.

#### Scenario: A session with no todo pins nothing
- **GIVEN** an empty transcript, or one containing only user messages
- **WHEN** the latest todo is selected
- **THEN** nothing SHALL be pinned

#### Scenario: The most recent write wins, with its counts and its active item
- **GIVEN** two todo writes in the transcript, the second listing three items of which one is completed and one in progress
- **WHEN** the latest todo is selected
- **THEN** the snapshot SHALL report three items and one completed
- **AND** the item in progress SHALL be the active one, carrying its active wording

#### Scenario: Within one message the newest call wins
- **GIVEN** a single assistant message carrying two todo writes
- **WHEN** the latest todo is selected
- **THEN** the snapshot SHALL be the second write's list

#### Scenario: An empty latest list pins nothing
- **GIVEN** the most recent todo write carrying no items
- **WHEN** the latest todo is selected
- **THEN** nothing SHALL be pinned, rather than an empty strip

#### Scenario: Tool calls that are not todos are ignored
- **GIVEN** a transcript whose only tool call is an ordinary shell command
- **WHEN** the latest todo is selected
- **THEN** nothing SHALL be pinned

### Requirement: TODO-02 — What counts as a todo, when the server's own label disagrees

A tool call SHALL be treated as carrying a todo when the server's typed detail
says so — whatever the tool is called, since a provider may name it anything — or
when its NAME is one of the names known to produce a todo. When the server's
detail is present but MALFORMED, the system SHALL fall back to deriving the
detail from the name, so a schema drift does not silently remove the plan while
the transcript still draws its card. A well-formed detail of a different type
SHALL remain authoritative and SHALL pin nothing. The list of todo-bearing names
and the deriver that recognises them SHALL agree in both directions: every listed
name SHALL actually produce a todo, and no unlisted name SHALL.

#### Scenario: The server's label wins over the name
- **GIVEN** a tool call named after something else, carrying a well-formed detail of type todo
- **WHEN** the latest todo is selected
- **THEN** the detail's items SHALL be pinned

#### Scenario: A malformed detail falls back to the name
- **GIVEN** a todo-named call whose detail fails validation — a wrong shape, or a type that does not exist
- **WHEN** the latest todo is selected
- **THEN** the list SHALL be rebuilt from the call's name and arguments
- **AND** the active item's wording SHALL be preserved

#### Scenario: A valid detail of another type stays the truth
- **GIVEN** a todo-named call carrying a well-formed detail of a different type
- **WHEN** the latest todo is selected
- **THEN** nothing SHALL be pinned

#### Scenario: Every name in the list really produces a todo
- **GIVEN** each name in the set of todo-bearing tool names, with plausible arguments
- **WHEN** the latest todo is selected for each
- **THEN** each SHALL produce a list
- **AND** the same SHALL hold for the CamelCase spellings the CLI writes

#### Scenario: A name outside the list produces nothing, in either direction
- **GIVEN** a corpus of plausible tool names, listed and unlisted
- **WHEN** the detail is derived for each
- **THEN** a name outside the list SHALL not be pinned
- **AND** any name whose derivation DOES yield a todo SHALL be in the list

### Requirement: TODO-03 — Selecting the plan is cheap and stable across streaming frames

The selection runs on every streaming frame over the whole transcript, so it
SHALL NOT validate a tool call's detail unless that call could carry a todo, and
it SHALL reuse the previous answer for the unchanged prefix of the transcript,
rescanning only the tail. When the answer has not changed it SHALL be the SAME
value as before, so the pinned strip does not repaint token by token. A change in
the PREFIX SHALL invalidate the reuse rather than return a stale answer.

#### Scenario: Without a todo, nothing is parsed
- **GIVEN** a transcript whose tool calls are all non-todo
- **WHEN** the latest todo is selected
- **THEN** nothing SHALL be pinned
- **AND** no call's arguments SHALL have been read

#### Scenario: An unchanged prefix yields the identical answer
- **GIVEN** a transcript already selected once, extended with a message carrying nothing
- **WHEN** the latest todo is selected again
- **THEN** the result SHALL be the very same value as before

#### Scenario: A newer todo in the tail beats one in the prefix
- **GIVEN** a transcript already selected, extended with a new todo write
- **WHEN** the latest todo is selected again
- **THEN** the snapshot SHALL be the new list

#### Scenario: Changing the head does not return a stale answer
- **GIVEN** a transcript whose head is replaced so that the todo it carried is gone
- **WHEN** the latest todo is selected
- **THEN** the transcript SHALL be rescanned and nothing SHALL be pinned

### Requirement: THINK-01 — Reasoning travels on its own channel, never inside the reply

Providers that emit extended thinking SHALL deliver it through the reasoning
channel and SHALL NOT let it reach the assistant's transcript text. The two are
different things: the reply is what the model said, the reasoning is how it got
there, and merging them puts the model's scratchpad in the middle of its answer.

#### Scenario: Thinking reaches the reasoning channel and not the reply
- **GIVEN** a turn whose stream carries a thinking block before the reply
- **WHEN** the turn is consumed
- **THEN** the thinking SHALL be delivered as a reasoning delta
- **AND** it SHALL NOT appear in the turn's text

### Requirement: THINK-02 — Only the assistant's own reasoning counts

Reasoning SHALL be surfaced only from the assistant's own events. A thinking
block appearing in an event the CLI INJECTS on the user's side is not the model
reasoning, and SHALL be discarded rather than shown.

#### Scenario: Injected thinking is discarded, the assistant's is kept
- **GIVEN** a thinking block inside an injected user event, followed by a thinking block inside an assistant event
- **WHEN** both are consumed
- **THEN** only the assistant's SHALL be delivered as reasoning

### Requirement: THINK-03 — A thinking block sent back to the API carries only what its type admits

When a turn's blocks are returned to the API, a thinking block SHALL be rebuilt
by CONSTRUCTION from the fields that type admits — its text and, when there is
one, its signature — rather than passed through with the scaffolding the streamer
added to accumulate deltas. A missing signature SHALL NOT be sent as an empty
one: an empty signature is a wrong signature, not an absent one. A redacted
thinking block SHALL carry only its encrypted body. Text and tool-use blocks
SHALL keep passing through whole.

#### Scenario: The thinking block loses the scaffolding and keeps the signature
- **GIVEN** a thinking block as the streamer builds it, carrying accumulation scaffolding alongside its text and signature
- **WHEN** it is prepared for the API
- **THEN** it SHALL contain exactly its type, its text and its signature
- **AND** the scaffolding fields the API rejects SHALL be absent

#### Scenario: A missing signature is not invented empty
- **GIVEN** a thinking block with no signature
- **WHEN** it is prepared for the API
- **THEN** the signature field SHALL be absent, not empty

#### Scenario: A redacted block carries only its encrypted body
- **GIVEN** a redacted thinking block
- **WHEN** it is prepared for the API
- **THEN** it SHALL carry its type and its encrypted data and nothing else

#### Scenario: Text and tool-use blocks are unaffected
- **GIVEN** a text block and a tool-use block from the same turn
- **WHEN** they are prepared for the API
- **THEN** each SHALL keep its own fields intact

### Requirement: THINK-04 — Reasoning stored on a message renders as its own row in the transcript

An assistant message that carries reasoning SHALL render it as a dedicated row
inside the message's content, labelled as reasoning, distinct from the tool rows
and from the prose. Reasoning persisted with the message SHALL survive to the
rendered transcript, so reopening a chat shows the same stack as watching it
stream.

#### Scenario: A stored message with reasoning shows a reasoning row
- **GIVEN** an assistant message persisted with reasoning text, two tool calls, prose and footer metadata
- **WHEN** the topic is opened and the message renders
- **THEN** a reasoning row SHALL be visible inside that message's content
- **AND** it SHALL be labelled as reasoning

### Requirement: CHAT-QUEUE-01 — La coda del turno è durevole, la drena UNA finestra sola, e uno stop non fa partire niente

Quando si scrive mentre un turno è in corso, il messaggio SHALL entrare in una
CODA DUREVOLE, che sopravvive alla chiusura della finestra e conserva le opzioni
con cui è stato scritto.

Il vuoto NON SHALL entrare in coda. Svuotare la coda SHALL rimuovere anche la
sua chiave: un contenitore vuoto lasciato a marcire su disco è indistinguibile
da una coda che nessuno ha mai usato. Correggere e togliere SHALL agire per
IDENTIFICATIVO, non per posizione — l'unica cosa che non cambia sotto i piedi
mentre la coda si svuota.

**Una sola finestra SHALL drenare la coda.** La seconda SHALL trovare la
prenotazione e tirarsi indietro. La prenotazione SHALL SCADERE, o una finestra
morta la terrebbe per sempre; e rilasciarla SHALL permettere alla stessa
finestra di riprendere subito. Su una coda vuota NON SHALL essere lasciato
nessun lucchetto appeso.

La coda SHALL partire TUTTA INSIEME, in un batch, nell'ordine in cui è stata
scritta — non un messaggio per turno. Opzioni diverse SHALL spezzare il batch, e
il resto SHALL partire al turno dopo; opzioni assenti e opzioni vuote SHALL
valere lo stesso e NON SHALL spezzare niente.

Una testa estratta che non parte SHALL tornare in TESTA, mai in fondo: chi era
dietro NON SHALL scavalcarla. Rimetterla due volte NON SHALL duplicarla, e
l'intero batch SHALL tornare in coda nel proprio ordine.

Il FRENO SHALL essere durevole e visibile alle altre finestre. Svuotare la coda
SHALL spegnerlo; togliere a mano l'ULTIMA riga SHALL spegnerlo, toglierne una di
mezzo NO. Uno stop NON SHALL mai far PARTIRE ciò che è in coda.

Un formato di coda più vecchio NON SHALL evaporare al primo caricamento del
codice nuovo: SHALL essere adottato, e la vecchia chiave SHALL sparire dopo
l'adozione. Un contenuto illeggibile SHALL dare una coda VUOTA, mai un errore.

#### Scenario: due finestre, una coda
- **GIVEN** una finestra che ha preso la prenotazione
- **THEN** la seconda NON SHALL drenare la stessa testa

#### Scenario: il turno non parte
- **GIVEN** un batch estratto e un invio rifiutato
- **THEN** SHALL tornare in testa nel proprio ordine

### Requirement: CHAT-QUEUE-02 — Il corpo di un invio non cresce con la conversazione, e il messaggio viaggia UNA volta

Il messaggio che si sta inviando SHALL essere l'ULTIMO elemento del corpo della
richiesta, e SHALL comparirvi UNA volta sola. È strutturale e non cosmetico: lo
stato locale contiene già quel messaggio quando il corpo viene costruito, e
riappenderlo lo faceva rientrare anche nella storia sul ramo che la ricostruisce
dal corpo.

Il peso del corpo NON SHALL crescere con la lunghezza della conversazione: SHALL
essere limitato a una coda di dimensione dichiarata. Su una chat legata a un
topic il server legge comunque solo l'ultimo elemento e ricostruisce la storia
dal proprio archivio — mandare l'intero trascritto a ogni turno è banda spesa
per essere buttata.

#### Scenario: un trascritto lungo
- **GIVEN** una conversazione di cento turni con risposte lunghe
- **THEN** il corpo della richiesta SHALL restare entro il budget dichiarato

### Requirement: CHAT-FOCUS-01 — Una risposta non richiesta va a UNA chat sola, e con una sola chat aperta è quella

Quando arriva qualcosa che nessuna chat ha chiesto, il sistema SHALL sceglierne
UNA come destinataria, e SHALL essere l'ULTIMA usata.

Con una chat sola aperta SHALL essere quella, anche se non ha MAI ricevuto il
fuoco: pretendere un fuoco esplicito significherebbe perdere il messaggio nel
caso più comune di tutti.

#### Scenario: una sola chat, mai messa a fuoco
- **GIVEN** una sola chat registrata e nessun fuoco mai dato
- **THEN** SHALL essere lei la destinataria

### Requirement: CHAT-COMPACT-01 — La compattazione lascia un SEGNO, e il segno non si moltiplica

Ogni compattazione SHALL lasciare un segno persistente, legato alla sessione,
letto dal fotogramma che la dichiara. Senza, una compattazione è invisibile: la
conversazione si accorcia e nessuno sa perché.

Il riconoscimento SHALL essere DIFENSIVO: i nomi dei campi sono cambiati fra le
versioni dello strumento, quindi SHALL essere provati più nomi alternativi e
SHALL degradare con grazia. Un motivo sconosciuto SHALL essere DICHIARATO tale,
non inventato. Un conteggio negativo o non numerico SHALL essere SCARTATO, non
convertito.

Un fotogramma che NON è un confine di compattazione SHALL restituire «niente»,
e la guardia SHALL riconoscere solo la coppia esatta di tipo e sottotipo.

Segni ripetuti sullo STESSO punto di ancoraggio SHALL essere COLLASSATI in uno,
e questo SHALL valere anche per ancore ripetutamente ASSENTI: senza, ogni
riaggancio ne aggiunge uno e la cronologia si riempie di confini che
descrivono lo stesso evento. Un'ancora che AVANZA SHALL invece produrre un segno
nuovo.

I segni SHALL essere per sessione e in ordine di creazione.

Il conteggio DOPO SHALL essere colmato a posteriori sul segno più recente che ne
è privo, e SHALL essere RIFIUTATO se non è MINORE di quello prima: una
compattazione non fa crescere il contesto, e accettare un numero più grande
scrive nel registro una cosa che non può essere successa. Un «dopo» SHALL essere
accettato anche quando il «prima» non è mai stato registrato.

Il colmo SHALL restituire il segno aggiornato — serve a ridiffonderlo — oppure
«niente» quando non c'era nulla da colmare.

#### Scenario: due confini sullo stesso punto
- **GIVEN** due dichiarazioni con la stessa ancora
- **THEN** SHALL restare un segno solo

#### Scenario: un «dopo» più grande del «prima»
- **GIVEN** un conteggio successivo non inferiore al precedente
- **THEN** SHALL essere rifiutato

### Requirement: CCLI-01 — Un'uscita non è un errore: annullamento, spegnimento e crash sono tre cose

L'uscita del processo della riga di comando NON SHALL essere trattata come un
errore per il solo fatto di essere un'uscita: prima, QUALUNQUE uscita con un
flusso vivo produceva un errore a schermo, e premere «ferma» mostrava un
allarme.

Un'uscita PULITA con un flusso vivo SHALL essere un ANNULLAMENTO — con il
parziale consegnato — non un errore. Un'uscita non pulita DURANTE un annullamento
SHALL restare un annullamento. Un'uscita non pulita SENZA annullamento in corso
SHALL essere un ERRORE VERO: nascondere un guasto reale è l'altra metà dello
stesso difetto.

Il turno in attesa SHALL essere rigettato con il motivo GIUSTO: annullato quando
la chiusura è pulita, morte del processo con il proprio codice quando non lo è.

Senza flusso vivo — turno già concluso — NON SHALL essere chiamato NIENTE: due
notifiche per lo stesso fatto sono peggio di una.

La bandiera «sto annullando» SHALL essere alzata PRIMA che l'evento di uscita
possa arrivare, o la corsa la perde. Un annullamento deciso da un guardiano SHALL
portare la propria ragione, così quell'uscita NON SHALL MAI essere registrata
come un gesto dell'utente.

Una FERMATA SENZA intermediario SHALL comunque annullare il turno vivo con la
causa dello spegnimento: fermare il processo non avvisa nessuno, e la chat resta
a metà frase.

Una sessione dichiarata INESISTENTE dall'altro capo SHALL essere DIMENTICATA e
SHALL produrre UN solo rinvio, seguito da una nota: senza, l'identificativo morto
non viene mai scordato e ogni turno lo ricicla in un giro infinito. Una sessione
APPENA CREATA NON SHALL MAI entrare in quel recupero, e un errore diverso NON
SHALL innescarlo.

#### Scenario: premere «ferma»
- **GIVEN** un flusso vivo e un'uscita pulita
- **THEN** SHALL essere un annullamento, non un errore

#### Scenario: un crash vero
- **GIVEN** un'uscita non pulita senza annullamento in corso
- **THEN** SHALL essere un errore

### Requirement: CCLI-02 — Gli orologi non uccidono chi è fermo su una domanda a schermo

Nessun orologio SHALL uccidere un processo mentre una DOMANDA all'utente è a
schermo: il tetto di vita del figlio, essendo il più basso, costringeva la
domanda stessa a scadere prima di lui.

Il tetto di vita SHALL RIARMARSI invece di uccidere quando c'è una domanda
aperta, e SHALL scattare normalmente quando non ce n'è.

Il mietitore dell'inattività NON SHALL mietere un processo fermo su una domanda,
e SHALL essere ANNULLATO quando comincia il turno successivo e RIARMATO quando
finisce: un orologio non annullato uccide a metà lavoro un turno che parte dopo
una pausa lunga. Un processo MORTO NON SHALL essere riarmato.

Un orologio ORFANO — rimasto da una voce sostituita — NON SHALL toccare il
processo che ha preso il suo posto: la fermata avviene PER CHIAVE, e l'orfano
ammazza il figlio di qualcun altro.

Azzerare la sessione SHALL CHIUDERE la domanda aperta: una voce rimasta fa
credere che ci sia una domanda a schermo, e questo DISARMA i guardiani del turno
successivo.

Il tempo concesso alla riga di comando per un comando esterno SHALL essere
MAGGIORE di quanto possa consumare una domanda a schermo: il suo valore
predefinito è più corto, e una domanda lasciata lì muore per un orologio che non
sa niente di lei.

L'ambiente passato al processo dell'agente NON SHALL portare SEGRETI, e NON SHALL
recintare i processori: la quota è per discorso, non per tutti.

#### Scenario: una domanda a schermo e il tetto di vita
- **GIVEN** una domanda aperta al raggiungimento del tetto
- **THEN** il tetto SHALL riarmarsi invece di uccidere

#### Scenario: un turno che parte dopo una pausa lunga
- **GIVEN** un mietitore armato dal turno precedente
- **THEN** SHALL essere annullato all'inizio del turno nuovo

### Requirement: CCLI-03 — La coda per sessione serializza, e un turno che solleva non la blocca

Turni concorrenti sulla STESSA sessione SHALL essere SERIALIZZATI: sovrapporli
significa intrecciare due scritture nello stesso processo.

Un turno che SOLLEVA SHALL comunque passare la mano al successivo: senza,
la sessione si blocca per sempre.

Sessioni DIVERSE NON SHALL bloccarsi a vicenda.

#### Scenario: un turno che fallisce
- **GIVEN** un turno che solleva un'eccezione
- **THEN** il turno in coda SHALL partire lo stesso

#### Scenario: due turni sulla stessa sessione
- **GIVEN** due invii sovrapposti
- **THEN** SHALL essere eseguiti uno dopo l'altro

### Requirement: CCLI-04 — Un turno sopravvive al riavvio: si RIADOTTA, non si riesegue

Un turno in corso mentre il server riparte SHALL essere RIADOTTATO e portato a
termine IN PLACE: il parziale SHALL essere ritrasmesso, il lavoro NON SHALL
essere rieseguito. Un turno CONCLUSO mentre il server era giù SHALL chiudersi
dalla ritrasmissione, senza ripartire.

Lo stato del turno all'avvio SHALL essere letto da CHI TIENE IL PROCESSO, non
dall'ombra a database: un turno fermo su una domanda è APERTO, e all'avvio non va
ucciso.

Un turno inviato DOPO un riavvio, verso il figlio che l'intermediario ha tenuto
vivo, SHALL comunque completarsi: riconoscere il processo senza AGGANCIARE chi
chiama significa che la risposta arriva a connessioni che non esistono più, e la
chat resta appesa per sempre. Un agganciamento PERSO a metà volo SHALL poter
essere RECUPERATO. Un intermediario che MUORE a metà volo SHALL far FINIRE il
turno, non lasciarlo credere vivo.

La ritrasmissione integrale di uno store all'avvio SHALL avvenire UNA volta sola:
in produzione ventisette store fino a 6,9 MB sono ~166 MB spediti e ripiegati al
posto di 83. La sonda che ispeziona SHALL poter PARCHEGGIARE l'aggancio per chi
riadotterà, e SHALL parcheggiare SOLO quando la riadozione è promessa. Due sonde
consecutive NON SHALL pestarsi.

La ripresa mirata SHALL ripartire subito DOPO l'ultimo esito, o una domanda
aperta non torna a schermo.

Un intermediario MUTO durante una riadozione NON SHALL rigettare: SHALL uscire
dall'errore, e il figlio NON SHALL essere bollato morto. Quel rigetto risaliva
fino a scrivere un avviso di fallimento SOPRA il contenuto della riga — e proprio
lì il danno è totale, perché la riadozione l'ha già svuotata per riusarla.

#### Scenario: il server riparte a metà turno
- **GIVEN** un turno in volo e un riavvio
- **THEN** SHALL essere riadottato e completato, non rieseguito

#### Scenario: l'intermediario muore a metà volo
- **GIVEN** la morte del processo intermedio
- **THEN** il turno SHALL finire, non restare appeso

### Requirement: CCLI-05 — Un esito SENZA testo chiude comunque il turno

Un esito finale privo di testo SHALL CHIUDERE il turno. Scartarlo perché vuoto è
ciò che rendeva una compattazione un turno che non finisce MAI: la coda seriale
resta presa, il messaggio successivo si accoda dietro, e mezz'ora dopo un
guardiano uccide il figlio scrivendo in chat che il modello non dava segni di
vita — sopra una compattazione perfettamente riuscita.

L'unica riga che SHALL restare rumore è quella di attesa: NON SHALL chiudere
niente.

Un esito con testo SHALL continuare a chiudere il turno col proprio testo, e un
esito d'ERRORE senza testo SHALL chiuderlo ugualmente: cadeva nello stesso buco.

Dopo la chiusura, il messaggio in coda SHALL partire davvero.

#### Scenario: una compattazione riuscita
- **GIVEN** un esito finale senza testo
- **THEN** il turno SHALL chiudersi e il messaggio in coda SHALL partire

#### Scenario: la riga di attesa
- **GIVEN** l'esito che dichiara di essere in attesa
- **THEN** NON SHALL chiudere niente

### Requirement: CCLI-06 — Persa la sessione, la conversazione si ricostruisce dal database

Quando la sessione sul disco non esiste più, il messaggio successivo SHALL essere
preceduto da un RIEPILOGO ricostruito dalle righe salvate, così il modello vede
il filo del discorso.

Il riepilogo SHALL essere costruito solo quando c'è davvero qualcosa da
ricostruire: nessun messaggio, o il solo turno appena scritto, NON SHALL
produrlo.

SHALL essere percorso il RAMO ATTIVO in ordine, escludendo il turno appena
aggiunto, e i turni A METÀ SHALL essere saltati.

I marcatori interni SHALL essere RIMOSSI e le buste di contesto di altri
fornitori SHALL essere SALTATE: sono nostre, non fanno parte della conversazione.

Oltre un tetto di turni SHALL essere TRONCATO, e l'omissione SHALL essere
DICHIARATA. Sotto il tetto NON SHALL essere troncato niente.

#### Scenario: rami fratelli
- **GIVEN** una conversazione con rami alternativi
- **THEN** SHALL essere percorso il ramo attivo

#### Scenario: oltre il tetto dei turni
- **GIVEN** più turni del tetto
- **THEN** SHALL essere troncato, dichiarando l'omissione

### Requirement: CCLI-07 — L'argomentario è un contratto FOTOGRAFATO, e le leve del prefisso sono MISURATE

Gli argomenti passati alla riga di comando SHALL essere fissati da un banco che
li fotografa: se qualcuno tocca una bandiera, il rosso SHALL arrivare LÌ e non in
produzione al primo turno — che è com'è andata finora, visto che nessun banco
nominava le bandiere critiche.

Ogni bandiera SHALL avere il proprio valore SUBITO DOPO: niente coppie spaiate.
Il canale dei permessi SHALL esserci in OGNI modalità, inclusa quella che
permette tutto.

Le leve che riducono il prefisso SHALL viaggiare nello STESSO blocco di
impostazioni e SHALL essere INDIPENDENTI: ognuna SHALL poter essere accesa da
sola, e ognuna SHALL poter essere vista FALLIRE quando è spenta. Una bandiera
condizionata da un'altra è come si desincronizza da sé stessa — ed è già costato
tutti i comandi esterni per un giorno.

Le impostazioni SHALL viaggiare come ARGOMENTO, non come ambiente: leggerle
dalle sorgenti dell'utente farebbe vincere il file di chi usa l'applicazione su
ciò che il prodotto ha deciso. Un valore nullo NON SHALL emettere la bandiera.

Il taglio degli strumenti SHALL essere un elenco di soli NOMI in UN argomento, e
SHALL essere DIVERSO fra lavoro dispacciato e chat. Gli strumenti che rendono
CAPACE l'agente NON SHALL essere in nessuna delle due liste, e la lista della
chat SHALL essere un SOTTOINSIEME di quella dispacciata. Il taglio SHALL poter
essere spento del tutto.

Il tetto ai risultati dei comandi esterni SHALL viaggiare come TESTO, perché è lì
che la riga di comando lo legge, e in sua assenza NON SHALL essere imposto
niente.

Il troncamento delle descrizioni SHALL usare un valore che la riga di comando non
IGNORA: lo zero viene ignorato e l'elenco resta intero.

Le abilità NON SHALL sparire: la bandiera che le spegne NON SHALL comparire.

Nella modalità a un colpo solo NON SHALL comparire la bandiera prolissa: con
l'uscita strutturata renderebbe l'uscita un elenco di eventi. Una scrittura di
configurazione FALLITA SHALL ripiegare senza restrizione, e NON SHALL inventare
un percorso.

#### Scenario: una bandiera modificata
- **GIVEN** un cambiamento negli argomenti
- **THEN** il banco della fotografia SHALL fallire

#### Scenario: una leva spenta
- **GIVEN** una leva del prefisso disattivata
- **THEN** il banco SHALL poterla vedere fallire

### Requirement: CCLI-08 — La riga di comando installata si DIAGNOSTICA, non si sbarra

La versione della riga di comando SHALL essere CONSULTATA da una decisione, non
solo mostrata: finiva unicamente dentro una diagnostica come testo, e una
versione troppo vecchia si scopriva a turno morto, con un errore di argomento
sconosciuto che nessuno collegava all'aggiornamento della settimana prima.

Il verdetto SHALL essere una DIAGNOSI, NON un cancello: un falso negativo che
spegne il fornitore è peggio del sintomo che evita.

Sotto il minimo SHALL essere DETTO, senza essere un divieto. Le bandiere critiche
mancanti SHALL essere ELENCATE, con dentro COSA si rompe: una bandiera assente
che porta via ogni comando esterno e ogni scrittura fuori dalla cartella, in
silenzio, non è una nota di versione.

Una versione ILLEGGIBILE SHALL essere ASSENZA DI INFORMAZIONE, non un guasto. Una
versione FUTURA SHALL restare compatibile finché non si dichiara una rimozione.
Una versione senza l'ultima cifra SHALL valere zero.

Il meccanismo delle rimozioni SHALL essere provato anche quando l'elenco è
VUOTO: un cancello che nessuno ha ancora armato deve essere già verificabile.

#### Scenario: una bandiera critica assente
- **GIVEN** una riga di comando di generazione precedente
- **THEN** SHALL essere elencata la bandiera e cosa si rompe

#### Scenario: una versione illeggibile
- **GIVEN** una stringa di versione non interpretabile
- **THEN** SHALL valere «non lo so», senza motivo di allarme

### Requirement: CCLI-09 — Il testo iniettato dalla riga di comando si stacca dal prefisso tecnico

Il testo che la riga di comando inietta dopo l'esecuzione di un'abilità SHALL
essere SEPARATO dal proprio prefisso tecnico prima di essere mostrato:
inoltrarlo come risposta lo incollava DENTRO la risposta a schermo, senza
nemmeno uno spazio in mezzo.

Il corpo su più righe SHALL restare INTERO. Un prefisso SENZA corpo, e un testo
vuoto, NON SHALL produrre niente da mostrare. La forma senza prefisso SHALL
passare intera.

#### Scenario: un'abilità con prefisso tecnico
- **GIVEN** un testo iniettato con l'intestazione tecnica
- **THEN** SHALL essere mostrato il solo corpo

#### Scenario: solo il prefisso
- **GIVEN** un prefisso senza corpo
- **THEN** NON SHALL essere mostrato niente

### Requirement: CCLI-10 — Il completamento a un colpo solo non restituisce MAI il testo grezzo

Nel completamento senza streaming SHALL essere estratto il CONTENUTO e il
CONSUMO dall'evento di esito. In un ELENCO di eventi SHALL vincere l'evento di
esito, MAI il testo grezzo: l'evento di apertura porta l'identificativo del
modello, e restituire il grezzo faceva leggere quel nome come se fosse la
risposta.

I gettoni della richiesta SHALL comprendere anche quelli riletti dalla memoria.

Senza evento di esito il contenuto SHALL essere VUOTO — chi chiama ha un
ripiego — non il testo grezzo. Un'uscita che non è strutturata SHALL passare come
testo semplice.

#### Scenario: un elenco di eventi
- **GIVEN** più eventi con dentro l'apertura e l'esito
- **THEN** SHALL vincere l'esito, e il grezzo NON SHALL comparire

#### Scenario: nessun evento di esito
- **GIVEN** un'uscita strutturata senza esito
- **THEN** il contenuto SHALL essere vuoto

### Requirement: CCLI-11 — I comandi esterni che si riscaricano a ogni avvio restano FUORI dalla sessione

Un comando esterno configurato globalmente che si RISCARICA a ogni avvio SHALL
essere ESCLUSO dall'inclusione automatica in sessione.

La regola SHALL essere STRETTISSIMA, perché il rischio da tenere basso è il
FALSO POSITIVO: escludere un comando che serviva è peggio che tenerne uno lento,
perché chi usa l'applicazione perde una capacità senza capire perché. SHALL
concorrere il tipo a processo, un avviatore che scarica, E la conferma
automatica.

Un comando che non ha un processo da far ripartire NON SHALL contare, anche se
porta un comando scritto. Un binario locale NON SHALL contare. Un avviatore
SENZA conferma automatica NON SHALL contare: non partirebbe nemmeno.

Un ingresso malformato NON SHALL far esplodere la restrizione.

Per il lavoro dispacciato SHALL essere scritta una configurazione che espone SOLO
il nostro ponte, col profilo ridotto, in modo RESTRITTIVO: quel ramo NON SHALL
leggere la configurazione personale, o smette di essere deterministico. Il profilo
ridotto SHALL essere un SOTTOINSIEME stretto di quello pieno.

#### Scenario: un avviatore che scarica, con conferma automatica
- **GIVEN** un comando esterno di quella forma
- **THEN** SHALL essere escluso dall'inclusione automatica

#### Scenario: un binario locale
- **GIVEN** un comando esterno che parte da un binario installato
- **THEN** NON SHALL essere escluso


### Requirement: CCLI-12 — Una CLI che esce presto NON deve portarsi dietro il server

Scrivere il prompt sullo stdin di un processo gia' uscito produce EPIPE, e
quell'errore arriva ASINCRONO mentre lo stream si chiude: nasce dentro `end()`,
non dentro `write()`, quindi nessun try/catch attorno alla scrittura puo'
vederlo. Senza un ascoltatore sullo stream diventa un'eccezione non gestita, e
il runtime abbatte l'INTERO processo del server invece della sola chat.

Il sistema SHALL ascoltare l'errore sullo stdin di ogni CLI che avvia — sia nel
turno singolo sia nella sessione lunga, dove la CLI puo' morire fra un turno e
l'altro — e SHALL lasciare che sia la chiusura del processo a riportare
l'uscita non-zero.

Una CLI che esce presto e' ORDINARIA, non una stranezza da banco di prova:
binario sbagliato, crash all'avvio, versione incompatibile. Su
un'installazione utente lo stesso EPIPE spegnerebbe il server mentre l'utente
sta lavorando.

Misurato il 2026-08-27 (run 33030011608): il server di test e' morto a meta'
corsa e si e' portato dietro ~200 prove mai partite, tutte a 0ms.

#### Scenario: la CLI e' gia' uscita quando le si scrive il prompt
- **GIVEN** un processo CLI che termina prima di leggere il proprio stdin
- **WHEN** il server gli scrive addosso un prompt piu' grande della pipe
- **THEN** il server SHALL restare vivo
- **AND** l'uscita non-zero SHALL essere riportata dalla chiusura del processo

### Requirement: CODEX-01 — Il consumo è quello dell'ULTIMA chiamata, e un errore incapsulato si apre

Gli eventi del fornitore a riga di comando alternativo SHALL essere instradati
verso il gestore del flusso senza avviare la riga di comando reale nei banchi:
richiederebbe una sessione autenticata e un servizio deterministico, e la
complessità vera sta comunque nei traduttori.

Il consumo del CONTESTO SHALL essere letto dall'ULTIMA chiamata, MAI dal totale
del turno: il totale somma tutte le chiamate, ed è esattamente l'errore che
faceva dichiarare al divisore della compattazione un contesto ESPLOSO. L'uscita
NON SHALL entrare nel contesto.

I nomi dei campi del consumo sono CAMBIATI fra le versioni: SHALL essere accettate
le varianti, comprese quelle di stile diverso e quelle annidate. Conteggi
NEGATIVI o non finiti SHALL essere SCARTATI.

Un consumo a ZERO NON SHALL accendere un indicatore vuoto, e un evento di
conteggio senza il proprio blocco NON SHALL emettere niente. Il totale di FINE
TURNO NON SHALL accendere l'indicatore: è un aggregato.

Senza una finestra dichiarata SHALL essere passato «non lo so».

Un messaggio d'errore incapsulato SHALL essere APERTO, fino a un tetto di
livelli, e SHALL FERMARSI quando incontra qualcosa che non è più incapsulato o
che non porta un messaggio. In assenza di tutto SHALL restare un testo
predefinito, non un vuoto.

L'uscita di un comando in corso SHALL essere ACCUMULATA per comando, e l'ultimo
parziale SHALL fare da ripiego quando l'esito non porta l'uscita. Un tipo di
evento SCONOSCIUTO SHALL essere IGNORATO.

#### Scenario: il totale del turno
- **GIVEN** un evento che porta sia l'ultima chiamata sia il totale
- **THEN** SHALL essere letta l'ultima chiamata

#### Scenario: un errore incapsulato due volte
- **GIVEN** un messaggio d'errore codificato dentro un altro
- **THEN** SHALL essere aperto fino al messaggio leggibile

### Requirement: CODEX-02 — Il turno riprende con `codex exec resume`, non con la cronologia ricostruita a mano

Il thread id del fornitore SHALL essere catturato dal primo evento `thread.started`
e persistito subito, prima ancora che il turno finisca: un crash o un abort a
metà turno NON SHALL perdere l'id già ricevuto.

Un turno successivo con un thread id persistito SHALL riprendere via
`codex exec resume <thread_id>` quando il rollout di quel thread esiste ancora
su disco. In quel caso SHALL essere inviato SOLO il nuovo messaggio: la
cronologia NON SHALL essere ricostruita lato client, perché il fornitore la
tiene già server-side.

Il primo turno di un RAMO (CHAT-FORK-01, riga in `chat_forks` con runtime
`codex-cli` e `parent_ref` valorizzato), che non ha ancora un thread suo, SHALL
partire con `codex exec fork <thread madre>` e il prompt da stdin, con `-` come
argomento del prompt: misurato su codex-cli 0.153.4, senza `-` `codex exec fork`
non legge stdin, crea il thread ed esce 0 senza fare il turno. Anche qui SHALL
essere inviato SOLO il nuovo messaggio; il thread nuovo arriva da
`thread.started` e si salva come ogni altro. Il fork SHALL valere solo se il
rollout della madre esiste e ha ancora la dimensione registrata al momento del
ramo (`parent_at`): una madre che ha fatto turni dopo li porterebbe nel ramo.
Altrimenti, o se il fork fallisce, `parent_ref` SHALL essere azzerato e il
turno SHALL partire fresco. Il fork SHALL avvenire al più una volta: all'arrivo
del `thread.started` di un turno `fork`, insieme al salvataggio del thread,
`parent_ref` e `parent_at` SHALL diventare nulli. Un thread del ramo dimenticato
dopo (rollout sparito, resume morto) SHALL ripartire fresco con la cronologia
del database, MAI con un altro fork dalla madre. `parent_ref` SHALL essere nullo
anche quando CHAT-FORK-01 lo lascia tale (Modifica o Rigenera sul ramo attivo,
righe dopo il punto oltre agli avvisi di background).

Un thread id persistito il cui rollout NON esiste più (o assente) SHALL essere
scartato, e il turno SHALL ripartire fresco con `codex exec`, tornando alla
cronologia ricostruita in markdown come SOLO in quel caso di fallback (per un
ramo, quella cronologia è la storia copiata).

#### Scenario: prima riga di un turno fresco
- **GIVEN** un turno che parte con `codex exec --json` (nessun thread id salvato)
- **WHEN** arriva l'evento `thread.started`
- **THEN** il thread id SHALL essere salvato subito, prima di ogni evento successivo

#### Scenario: turno successivo con rollout ancora presente
- **GIVEN** un thread id persistito il cui rollout esiste ancora
- **THEN** il turno SHALL usare `codex exec resume <thread_id>`
- **AND** il prompt inviato SHALL contenere SOLO il nuovo messaggio

#### Scenario: thread id persistito ma rollout sparito
- **GIVEN** un thread id persistito il cui rollout NON esiste più
- **THEN** il turno SHALL ripartire fresco con `codex exec`
- **AND** il thread id stantio SHALL essere dimenticato

#### Scenario: primo turno di un ramo Codex
- **GIVEN** un ramo senza thread suo, con `parent_ref` = T e il rollout di T della stessa dimensione di `parent_at`
- **WHEN** si monta l'argv del turno
- **THEN** l'argv è `exec fork T --json --skip-git-repo-check`, i flag condivisi con la sandbox via `-c`, e `-` in fondo
- **AND** il prompt contiene SOLO il nuovo messaggio

#### Scenario: la madre è andata avanti
- **GIVEN** lo stesso ramo, con il rollout di T più lungo di `parent_at`
- **WHEN** parte il primo turno
- **THEN** il turno parte fresco con `codex exec` e la cronologia in markdown della storia copiata
- **AND** `parent_ref` del ramo diventa nullo

#### Scenario: il fork di un ramo Codex si consuma
- **GIVEN** un ramo Codex il cui primo turno `fork` ha ricevuto `thread.started` con il thread R, poi 2 turni suoi, poi il rollout di R cancellato, e la madre ferma
- **WHEN** parte il turno dopo
- **THEN** `parent_ref` del ramo è nullo dal primo `thread.started`
- **AND** il turno parte fresco con `codex exec` e la cronologia in markdown della storia copiata e dei 2 turni del ramo, non con `exec fork`

### Requirement: DELTA-01 — Il cumulativo si converte in pezzi per UN fornitore solo

Un fornitore che manda il testo INTERO a ogni evento SHALL essere convertito in
pezzi nuovi, e la conversione SHALL avvenire in UN posto dichiarato — non
indovinata a valle.

La conversione NON SHALL essere applicata a chi manda già i pezzi: su quelli è
una PERDITA DI DATI MUTA. Due pezzi UGUALI di fila — una parola ripetuta, due
ritorni a capo, due segni uguali in una tabella — diventerebbero uno solo, e la
riga salvata e lo schermo direbbero la stessa cosa sbagliata.

Il testo ricomposto dai pezzi SHALL essere IDENTICO all'ultimo cumulato. Un
cumulato IDENTICO al precedente NON SHALL produrre niente. Il primo evento SHALL
produrre tutto. Un cumulato che NON estende il precedente SHALL ripartire INTERO,
non mutilato.

Una conversazione con due turni consecutivi dello stesso ruolo SHALL essere
RICUCITA prima di essere consegnata: l'interfaccia del modello la rifiuta con un
errore secco e l'intero turno va perso. I turni VUOTI SHALL sparire — nel
database vivo se ne contavano centosettanta — l'assistente in TESTA SHALL essere
tolto, e il messaggio nuovo in coda SHALL fondersi col turno che lo precede.

#### Scenario: due pezzi uguali di fila
- **GIVEN** un fornitore che manda già i pezzi
- **THEN** la conversione NON SHALL essere applicata, e nessun pezzo SHALL sparire

#### Scenario: due turni dello stesso ruolo
- **GIVEN** una conversazione non alternata
- **THEN** SHALL essere ricucita prima della consegna

### Requirement: FAST-MODE-06 — Lo stato della modalità rapida si LEGGE, e «non lo so» non è «spenta»

Lo stato della modalità rapida SHALL essere letto dagli eventi che lo portano —
sia all'apertura sia alla chiusura del turno — e il formato SHALL essere quello
REALE della riga di comando, non uno inventato.

Un evento che NON ne parla SHALL dare «non lo so», che NON SHALL essere
confuso con «spenta»: finché non lo sappiamo il comando NON SHALL essere mandato
al buio, ma il pulsante NON SHALL essere spento.

Un motivo ASSENTE SHALL valere «niente la blocca». Valori FUORI dall'insieme
noto NON SHALL essere inoltrati: chi guarda non deve indovinarli.

Il comando SHALL essere mandato SOLO quando serve, e sempre ESPLICITO: se lo
stato è già quello voluto NON SHALL essere mandato niente. Se la modalità è
BLOCCATA NON SHALL esserle parlato: il rifiuto finirebbe nella chat.

Un ri-annuncio IDENTICO NON SHALL essere trattato come un cambiamento.

Il moltiplicatore di costo SHALL essere CALCOLATO dal listino, non scritto a
mano: cambia il listino, cambia il numero. Fuori dalla famiglia che la offre NON
SHALL esserci nessun numero, e un modello SENZA prezzo SHALL dare «nessun
numero», non uno zero.

#### Scenario: nessuno ha ancora parlato
- **GIVEN** nessun evento che dichiari lo stato
- **THEN** NON SHALL essere mandato nessun comando, e il pulsante SHALL restare vivo

#### Scenario: un modello senza prezzo
- **GIVEN** un modello di cui non si conosce il listino
- **THEN** NON SHALL essere mostrato nessun moltiplicatore

### Requirement: FAST-MODE-04 — Un comando che non si può usare NON occupa una riga

Quando la riga di comando dichiara che la modalità rapida NON è disponibile — ad
esempio perché la via usata dalle chat richiede un'adesione separata — il
pulsante NON SHALL comparire affatto.

NON SHALL essere mostrato disattivato, e NON SHALL fare in silenzio una cosa
DIVERSA: prima, con lo stesso clic, il server sostituiva il modello con uno più
piccolo — il comando prometteva una cosa e ne faceva un'altra.

Gli ALTRI comandi della riga SHALL restare al loro posto: togliere quello
indisponibile NON SHALL spostare né nascondere il resto.

#### Scenario: la modalità è dichiarata non disponibile
- **GIVEN** un motivo di indisponibilità dichiarato dalla riga di comando
- **THEN** il pulsante NON SHALL essere presente

#### Scenario: gli altri comandi
- **GIVEN** il pulsante assente
- **THEN** gli altri comandi della riga SHALL restare visibili

### Requirement: FAST-MODE-05 — Sotto il comando c'è QUANTO COSTA, e il numero non è un bersaglio

Quando la modalità rapida è disponibile, accanto al comando SHALL essere mostrato
il MOLTIPLICATORE di costo: «più veloce» da solo non è un'informazione finché non
si dice quanto costa.

Il numero SHALL comparire ANCHE nella descrizione al passaggio: il solo
distintivo non dice DI COSA è il multiplo.

Il distintivo NON SHALL essere un bersaglio tattile a sé — gli eventi del
puntatore SHALL essere spenti su di esso — e NON SHALL far crescere l'altezza del
comando.

#### Scenario: la modalità è disponibile
- **GIVEN** un moltiplicatore dichiarato
- **THEN** SHALL essere mostrato accanto al comando e nella descrizione

#### Scenario: il distintivo
- **GIVEN** il distintivo del costo
- **THEN** NON SHALL ricevere eventi del puntatore né cambiare l'altezza del comando

### Requirement: CHAT-QUEUE-03 — «Ferma» ferma, e tre messaggi in coda partono in UN turno

La coda dei messaggi SHALL essere disegnata UNA volta sola: due rappresentazioni
della stessa coda a due centimetri di distanza sono due verità da tenere
allineate.

Premere FERMA NON SHALL far partire il messaggio successivo. Lo svuotamento della
coda NON SHALL avere come unica condizione «non sta più scrivendo»: si preme
fermare per fermare l'agente, e partiva il messaggio dopo senza che nessuno
l'avesse chiesto. Dal 03/09/2026 il comando che manda subito resta offerto
anche a coda ferma, e la regola su quando esiste e cosa promette è
CHAT-QUEUE-04.

Un messaggio in coda SHALL essere MODIFICABILE e RIMUOVIBILE prima di partire.
SHALL esistere un comando per mandarlo SUBITO senza aspettare la fine del turno.

Alla ripresa la coda SHALL ripartire dalla TESTA: nessun sorpasso. Più messaggi
accodati SHALL partire INSIEME, in UN SOLO turno, e comparire come UNA bolla:
estrarne uno per volta significa tre giri di modello e tre volte il contesto per
una cosa sola.

Un COMANDO NON SHALL essere accodato: agisce subito.

Un rifiuto per «turno già in volo» SHALL mettere il messaggio in TESTA alla coda e
farlo partire a fine turno, e NON SHALL lasciare a schermo una bolla fantasma.
«Fine turno» è quella che dice il server (CHAT-QUEUE-07), non la fine di uno
stream o lo stato di una finestra.

#### Scenario: si preme ferma
- **GIVEN** un messaggio in coda e il turno fermato
- **THEN** il messaggio SHALL restare in coda

#### Scenario: tre messaggi accodati
- **GIVEN** tre messaggi in coda e un turno che finisce
- **THEN** SHALL partire insieme, in un turno solo

### Requirement: CHAT-QUEUE-04 — An idle queue still has its send-now control

The send-now command of the queue SHALL be rendered whenever the queue holds at
least one message and a handler for it exists, whether or not a turn is in
flight. With a turn in flight it SHALL promise to stop that turn first; with
nothing running it SHALL fire the queue right away, and its label SHALL say
which of the two it does. It SHALL NOT be rendered without a handler, and an
empty queue SHALL render nothing at all.

> **Why.** The control used to exist only while a turn was in flight, on the
> theory that its job is to cut a running turn short. But a queue can be idle
> for reasons that are not a choice: the turn it waited for ended while this
> window was not listening (a reload, a relaunch, a socket lost for a second).
> The dashed bubbles then sat in the transcript with no control that could
> fire them, and the way out was to copy the text, delete the bubble and type
> it again. Since 2026-09-03 the command is there in both states; what changes
> with the state is what it promises.

#### Scenario: a queue with a turn in flight
- **GIVEN** one queued message and a turn still streaming
- **THEN** the send-now control is rendered and marked as busy

#### Scenario: a queue nobody released
- **GIVEN** one queued message and no turn in flight
- **THEN** the send-now control is rendered and marked as idle
- **AND** pressing it fires the queue now

#### Scenario: nothing to send
- **GIVEN** an empty queue
- **THEN** the queue renders nothing, and no send-now control

### Requirement: CHAT-QUEUE-05 — Il banner dei messaggi non inviati dice QUALE chat, e ci porta

Quando uno o più messaggi non sono partiti, il banner SHALL mostrare una riga
per chat, con il nome del topic, il conteggio e un'anteprima del testo: un
conteggio globale senza nome manda la persona a cercare la chat a mano.

Il click su una riga SHALL aprire o mettere a fuoco quella chat; «Riprova» e
«Scarta» SHALL agire per riga, non su tutte le chat insieme. Le stringhe SHALL
passare dai cataloghi i18n. Su un telefono il banner SHALL stare sopra la barra
in basso, non sopra il composer.

#### Scenario: due chat con messaggi fermi
- **GIVEN** un messaggio non inviato in due chat diverse
- **THEN** il banner SHALL mostrare due righe con i due nomi, e il click sulla prima SHALL portare a quella chat

#### Scenario: scarta una riga
- **GIVEN** due righe nel banner
- **WHEN** la persona scarta la prima
- **THEN** la seconda SHALL restare

### Requirement: CHAT-QUEUE-06 — Il messaggio non inviato sta nella SUA chat, e niente lo copre o lo taglia

Un messaggio non inviato di una chat che è A SCHERMO SHALL comparire dentro
quella chat, come striscia sopra il suo composer, con il testo, «Riprova» e
«Scarta». La striscia sta nel flusso: NON SHALL coprire il composer.

I messaggi delle chat NON a schermo SHALL comparire in una fascia che non copre
nessuna pane: sul desktop sotto la griglia, nel flusso; sul telefono nella fascia
degli avvisi sopra la barra in basso, visibile anche col cassetto aperto. Nessuna
delle due SHALL essere tagliata da un contenitore o dal bordo della finestra.
Toccare una riga della fascia SHALL portare alla chat (sul telefono chiudendo il
cassetto), e da lì il messaggio passa nella striscia della chat.

Motivo: il 24/09 il vecchio avviso galleggiava sopra la griglia, e con tre
colonne cadeva sul composer della pane al centro, qualunque fosse la chat del
messaggio, ed era tagliato.

#### Scenario: tre colonne, un messaggio nella colonna di destra
- **GIVEN** tre chat aperte in tre colonne e un messaggio non inviato della chat di destra
- **THEN** la striscia SHALL stare dentro la chat di destra, intera, senza sovrapporsi a nessun composer

#### Scenario: un messaggio di una chat chiusa
- **GIVEN** un messaggio non inviato di una chat senza tab
- **THEN** la fascia SHALL mostrarlo intero, senza sovrapporsi a nessuna chat

### Requirement: CHAT-QUEUE-07 — A queued message leaves only after the REAL end of the turn, as the server decides it

A message written while a turn runs SHALL reach the provider only after that
turn has really ended: for claude-code the CLI's `result` (or its exit), for the
other runtimes the end of their turn process or request. The decision SHALL be
the server's: one ledger of open turns per session, holding a session open while
the route streams a turn, while the CLI is between a turn's `system/init` and
its `result` whoever started it (a background task's report, a cron fire, a
Monitor), and, after a restart, while the boot has not yet decided about a
session whose child may be mid-turn. Every open/close SHALL be broadcast to every
window, and a window that (re)connects SHALL receive the open turns.

The queue SHALL drain on that word and on nothing else: not on a `stream:end`,
not on the window's own streaming flag, not on a history read, not on a 409's
cleanup. A message written during a turn SHALL remember that turn, durably and
for every window, and SHALL NOT leave before the server has said that turn is
over. A Stop seen from another device SHALL hold that device's queue too. A
question or a plan approval on screen SHALL keep the queue waiting for the
person. Several queued messages SHALL still leave as ONE turn, in order, with
their attachments; a batch refused with «turn in flight» SHALL go back whole,
with the same ids, and SHALL wait for the refusing turn; the batch SHALL carry
its head's id as idempotency key, so two windows that both claimed it send it
once.

The server SHALL be safe on its own. The 409 gate SHALL read the same ledger. A
message that still reaches a provider while a turn of the same session runs
SHALL be parked and released at that turn's end, and SHALL NEVER be written into
the running turn: claude-code (direct child and broker alike) waits for the
CLI's `result` before writing to stdin, and the CLI's own turn keeps its own
row; Codex waits for the previous `codex exec` of the thread to exit; ACP waits
for the previous `session/prompt` to be answered. A Stop pressed while a message
is parked SHALL mean nothing is written, and SHALL still stop the turn the
message was parked behind.

How a turn ended SHALL travel with its close, because every window drains on
the close and the route's `stream:end` comes after it: a person's Stop
(`stopped`) and a question left for the person (`awaitsHuman`, the plan
approval) SHALL be part of the closing `turn:state`, and a window that connects
SHALL receive the sessions whose last turn ended waiting for a person, and the
latest turn a person stopped on each session since the server started
(`lastStop`), kept past the turns after it. What was queued before a Stop SHALL
hold on it in every window, whenever that window hears it; the person's own
send, «send now» or emptying the queue SHALL lift it for every window of the
profile, and a later word of the same Stop SHALL NOT hold the queue again.
A Stop of a server that has since restarted SHALL NOT hold a message queued
after it: a window that stayed open through the restart SHALL know of that
Stop only what a window opened after it knows, the holds it already raised.

A Stop on claude-code SHALL close the session's turn at once: the stopped child
takes no more input and its tail belongs to nobody, so waiting for its exit
(seconds under load, forever if the SIGINT is lost) only kept a message typed
after the Stop waiting.

> **Why.** 29/09, Attilio: «assicuriamoci che i messaggi che sono da inviare in
> coda effettivamente vengano gestiti come fa anche Claude Code, perché vedo che
> a volte li invia anche prima che finisca il turno». Measured on production
> (15-29/09): 7 messages reached the CLI in the middle of a turn, 4 of them
> because the CLI had opened a turn by itself and Topics registered it only at
> the model's first line (p50 4.7 s, p90 13.6 s later): the 409 gate was open
> and the message was written into that turn (chat 33966f4e, 27/09 21:31 and
> 21:42). Claude Code's interactive mode, by its documentation, hands queued
> messages to the model at the next tool boundary of the running turn; Topics
> keeps them for the end of the turn, which is the behaviour asked for here.

#### Scenario: the CLI opens a turn by itself
- **GIVEN** a claude-code chat whose CLI starts a turn on a background task's report
- **WHEN** the person sends a message before the model has written anything
- **THEN** the server SHALL refuse it as «turn in flight», and the window SHALL queue it for that turn
- **AND** the CLI SHALL read the message only after that turn's `result`, once

#### Scenario: a reconnect in the middle of a turn
- **GIVEN** a queued message and a turn of several assistant messages and tool calls
- **WHEN** the window's socket drops and reconnects mid-turn
- **THEN** the message SHALL NOT leave before the turn's real end, and SHALL leave once after it

#### Scenario: a message that slips past the gate
- **GIVEN** a message that reaches the provider while the CLI is in a turn of its own
- **THEN** nothing SHALL be written to stdin before that turn's `result`
- **AND** a Stop pressed meanwhile SHALL leave stdin untouched

#### Scenario: a Stop on another device
- **GIVEN** a queued message on the phone and the turn stopped from the desktop
- **THEN** the phone's queue SHALL hold, whatever the runtime and even when the child had not started its turn yet
- **AND** a later turn that ends plainly SHALL NOT release it: only the person's own send does

#### Scenario: a Stop on another device while the phone's socket is down
- **GIVEN** a queued message on the phone, whose socket is closed (the app in the background)
- **WHEN** the desktop stops the turn, and the phone reconnects after the close, or after a later turn
- **THEN** the phone's queue SHALL hold on that Stop
- **AND** the person's next message SHALL take it along, in one turn

#### Scenario: Stop, then a message typed at once
- **GIVEN** a claude-code turn stopped by the person, whose child takes seconds to exit
- **WHEN** the person types a message right after the Stop
- **THEN** it SHALL reach the CLI once, after the Stop, and SHALL NOT stay queued

#### Scenario: two windows of one profile, «send now» in one
- **GIVEN** a Stop lifted by «send now» in one window
- **WHEN** the other window reads the close of the stopped turn after that
- **THEN** it SHALL NOT hold the queue again, and a message queued in the next turn SHALL leave at its end

#### Scenario: a Stop heard before a server restart
- **GIVEN** a window that heard a Stop with nothing queued, and stayed open while the server restarted
- **WHEN** another window of the profile queues a message during a turn of the new server
- **THEN** the message SHALL leave at the end of that turn

#### Scenario: a plan approval left by a turn started elsewhere
- **GIVEN** a queued message and a turn, started from another device or the board, that ends on a plan approval
- **THEN** the message SHALL wait while the approval is unanswered, even in a window whose transcript does not show it yet
- **AND** SHALL leave with the person's answer

#### Scenario: Stop on the CLI's own turn while a message is parked behind it
- **GIVEN** a message parked behind a turn the CLI opened by itself (a cron, a report), adopted into the chat
- **WHEN** the person presses Stop
- **THEN** the CLI's turn SHALL be interrupted, and the parked message SHALL NOT be written

#### Scenario: a cron fires right after the result
- **GIVEN** a claude-code chat with an armed cron, whose fire the CLI holds until the turn's `result`
- **WHEN** the queue leaves on that `result` and the CLI starts the cron's turn before its `system/init` is out
- **THEN** the message SHALL wait for the cron turn's `result` before reaching stdin
- **AND** a queued wake that opens no turn SHALL hold it no longer than the recorded gap (2 s)

#### Scenario: the server restarts in the middle of a turn
- **GIVEN** a queued message and a turn interrupted by a restart
- **WHEN** the window reconnects before the boot has reattached or resumed that turn
- **THEN** the session SHALL be open until the boot has decided about it, and the message SHALL leave after the resumed turn

### Requirement: CHAT-BUBBLE-01 — La bolla porta l'id del SERVER, e una riadozione non la raddoppia

Il segnaposto disegnato quando parte un turno SHALL portare l'IDENTIFICATIVO che
il server ha annunciato, non uno coniato in locale. Con due identificativi per la
stessa riga, il primo ricaricamento della storia A TURNO APERTO mostra la stessa
risposta DUE volte — una ferma e una che continua a crescere sotto.

Un ricaricamento a metà turno NON SHALL raddoppiare la risposta, e i pezzi
successivi SHALL continuare ad aggiungersi DENTRO la stessa bolla.

Una RIADOZIONE SHALL essere DICHIARATA nel segnale di apertura, e il client SHALL
SVUOTARE la bolla prima di riscriverla. Senza quel segnale la ritrasmissione si
SOMMA a ciò che c'è già — ed è la ragione per cui il segnale esiste. La pulizia
NON SHALL essere fatta cancellando il corpo della riga sul database: se il turno
muore prima di rimetterla a posto, la cancellazione diventa definitiva e resta una
bolla vuota per sempre.

#### Scenario: un ricaricamento a turno aperto
- **GIVEN** un turno in corso e la storia ricaricata
- **THEN** SHALL comparire una sola risposta

#### Scenario: una riadozione dichiarata
- **GIVEN** un'apertura marcata come riadozione
- **THEN** la bolla SHALL essere svuotata prima di essere riscritta

### Requirement: CHAT-WAIT-01 — Fermo su una domanda NON è «sta lavorando»

Un turno parcheggiato su una domanda SHALL smettere di dichiararsi in lavoro: il
puntino che pulsa, la frase di fatica che ruota, il bagliore. Chi guarda legge
«sto elaborando» e aspetta, mentre la palla è sua da mezz'ora.

La riga SHALL dire che si è IN ATTESA DI UNA RISPOSTA, e il cronometro del lavoro
NON SHALL scorrere. Ricevuta la risposta, il cronometro SHALL tornare a
dichiarare il lavoro fatto.

Un turno parcheggiato SHALL CHIUDERSI VISIVAMENTE come un messaggio finito, con il
proprio conto: gettoni distinti fra rilettura e nuovi, e il costo. Un aggiornamento
PARZIALE del consumo NON SHALL azzerare un costo già noto.

Anche FUORI dalla chat il segnale SHALL dire FERMA, non «sta lavorando».

#### Scenario: parcheggiato su una domanda
- **GIVEN** un turno fermo su una domanda
- **THEN** la riga SHALL dire che aspetta, e il cronometro NON SHALL scorrere

#### Scenario: il segnale fuori dalla chat
- **GIVEN** lo stesso turno
- **THEN** il segnale esterno SHALL dire «ferma»

### Requirement: CHAT-BANNER-01 — Un messaggio genera UN banner, anche con due finestre aperte

Un avviso nato da un frame diffuso a TUTTE le finestre SHALL produrre UN SOLO
banner, non uno per finestra. L'effetto che lo ascolta è montato una volta per
finestra, quindi due finestre aperte producevano due avvisi per lo stesso
messaggio — e nessun cancello poteva risolverlo, perché in ogni finestra sono
tutte vere contemporaneamente.

Il silenziamento di un discorso SHALL valere per TUTTE le finestre.

Con l'applicazione APERTA la preferenza su chi parla SHALL produrre UNA voce
sola — quella di sistema oppure quella nella pagina — MAI entrambe. I comandi
d'azione SHALL essere gli STESSI nelle due forme.

#### Scenario: due finestre aperte
- **GIVEN** lo stesso messaggio diffuso a entrambe
- **THEN** SHALL comparire un solo banner

#### Scenario: un discorso silenziato
- **GIVEN** il silenziamento attivo
- **THEN** nessuna finestra SHALL mostrare il banner

### Requirement: CHAT-DIALOG-01 — Una conferma NON congela il resto dell'applicazione

Le conferme SHALL essere disegnate DENTRO l'applicazione e NON SHALL usare il
dialogo modale del sistema: quello CONGELA il filo della vista finché non lo si
chiude a mano — chat in streaming ferme, cronometri fermi, l'applicazione in
ostaggio.

Con una conferma aperta, un turno accanto SHALL CONTINUARE a scrivere e il suo
cronometro SHALL avanzare.

Annullare SHALL essere possibile da tastiera e NON SHALL eseguire l'azione.

#### Scenario: una conferma aperta
- **GIVEN** un turno in streaming e una conferma a schermo
- **THEN** il turno SHALL continuare e il cronometro SHALL avanzare

#### Scenario: annullare
- **GIVEN** la conferma annullata
- **THEN** l'azione NON SHALL essere eseguita

### Requirement: CHAT-LAYOUT-01 — La chat si MISURA: varchi, allineamenti, contrasto e bersagli

La geometria della conversazione SHALL essere MISURATA, non guardata: sono cose
che a occhio si giudicano male, e uno scatto non le prenderebbe.

La bolla dei propri messaggi SHALL essere un grigio di sistema, non il colore del
marchio, e SHALL raggiungere il contrasto minimo.

Sotto l'ultima risposta SHALL restare SEMPRE un varco, anche quando l'area di
scrittura CAMBIA ALTEZZA: misurato prima del rimedio, bastava che si RESTRINGESSE
perché il varco andasse a zero.

Le strisce sopra il campo SHALL essere allineate FRA LORO e col campo.

Il comando che riporta in fondo SHALL essere centrato sulla colonna, non appeso
al bordo.

La chat VUOTA SHALL mostrare a schermo le scelte del discorso — chi risponde e con
quale modello — e sotto una soglia di altezza NON SHALL mostrarle affatto. La
verifica SHALL guardare il DOCUMENTO: provare la funzione che compone la stringa
lascia scoperto il caso in cui il componente non la disegna mai.

Su TELEFONO nessun testo SHALL dipingere DIETRO il campo di scrittura, a NESSUNA
posizione di scorrimento: il difetto segnalato era il BORDO — la riga tagliata di
netto che restava mezza e illeggibile.

La misura SHALL essere accompagnata da una CONTROPROVA che inietta i difetti
apposta: un misuratore che non si è visto fallire non misura.

Le violazioni gravi di accessibilità SHALL essere ZERO.

#### Scenario: l'area di scrittura si restringe
- **GIVEN** il campo che cambia altezza
- **THEN** il varco sotto l'ultima risposta SHALL restare

#### Scenario: la controprova
- **GIVEN** difetti iniettati di proposito
- **THEN** il misuratore SHALL segnalarli tutti

### Requirement: CHAT-DOOR-01 — Un turno concorrente si ferma alla PORTA, prima di scrivere in chat

Una seconda richiesta di turno sulla STESSA sessione SHALL essere fermata con un
CONFLITTO alla porta, PRIMA che il messaggio venga scritto in chat. Senza il
cancello entrambe arrivano ad aprire uno stream, il secondo SOVRASCRIVE la voce
del primo, e la chiusura del primo turno chiude il secondo.

Una sessione LIBERA SHALL passare, e uno stream su un'ALTRA sessione NON SHALL
bloccare questa.

La forma di RIADOZIONE SHALL essere ESENTE dal cancello e SHALL entrare con
l'elenco dei messaggi VUOTO: è il suo formato, non un errore. Rifiutarla come
malformata produce un corpo strutturato che chi chiama consuma come se fosse uno
stream, riportando un turno mai iniziato come finito bene — misurato: nove turni
FABBRICATI, pagati, e la risposta vera mai arrivata. Un elenco vuoto SENZA
riadozione SHALL restare un rifiuto.

Una riadozione su un fornitore che NON sa riadottare SHALL essere dichiarata NON
IMPLEMENTATA, e NESSUN messaggio SHALL essere inviato.

Una chiave di messaggio RIPETUTA SHALL essere un conflitto DICHIARATO come
duplicato, e la riga NON SHALL raddoppiarsi. Chiavi diverse SHALL restare
messaggi diversi, e senza chiave il comportamento SHALL restare quello di prima.

#### Scenario: due invii sulla stessa sessione
- **GIVEN** un turno già in volo
- **THEN** il secondo SHALL essere respinto senza scrivere in chat

#### Scenario: una riadozione senza messaggi
- **GIVEN** una richiesta di riadozione con l'elenco vuoto
- **THEN** SHALL essere accettata

### Requirement: CHAT-BUBBLE-02 — Riadottare FONDE: non si perde ciò che c'era, e il verdetto vince

La ricomposizione di una riga dopo una riadozione SHALL FONDERE ciò che arriva
con ciò che c'era, e SHALL DICHIARARE se è arrivato qualcosa di nuovo.

Una ritrasmissione MUTA — la coda già chiusa — SHALL restituire il testo e
LASCIARE gli strumenti di prima: il fornitore ri-consegna solo il risultato
finale, chi ascolta non vede nessuno strumento, e la riga svuotata resterebbe
senza la domanda a schermo.

Una ritrasmissione COMPLETA SHALL far vincere gli strumenti NUOVI, senza
doppioni; una che ha PERSO gli strumenti NON SHALL sostituire quella di prima. Un
elenco ILLEGGIBILE SHALL essere CONSERVATO: nel dubbio non si butta.

La decisione «questa riga è vuota» SHALL essere presa DOPO la fusione, non prima:
un turno con decine di strumenti e molti blocchi di testo è stato etichettato
come chiuso senza produrre niente.

Il VERDETTO del turno SHALL sopravvivere anche quando si tengono i blocchi
vecchi: è l'unica cosa che spiega un fallimento della riadozione, e tenendo solo
i blocchi di prima veniva buttato. A metà strada SHALL restare il testo intero di
prima; raggiunto e superato SHALL vincere quello nuovo; alla FINE SHALL vincere il
verdetto anche se è più corto.

#### Scenario: una ritrasmissione muta
- **GIVEN** una coda già chiusa
- **THEN** gli strumenti di prima SHALL restare

#### Scenario: la riga sembra vuota
- **GIVEN** una riga svuotata prima della fusione
- **THEN** il giudizio SHALL essere dato dopo la fusione

### Requirement: CHAT-CONV-04 — Rigenerare porta le PROVE, o il modello inventa le azioni

Il percorso di rigenerazione gira SENZA strumenti su entrambi i motori, mentre il
prompt continua a descriverli: il risultato è una risposta INVENTATA, con dentro
le chiamate scritte come testo e gli esiti immaginati — nessuno di quei comandi è
mai girato.

La rigenerazione SHALL passare al modello un blocco di PROVE: le azioni davvero
eseguite col loro nome, il loro ingresso e il loro ESITO.

Un'azione SENZA esito registrato SHALL essere DICHIARATA muta, e il blocco SHALL
dire di NON darne per scontato il risultato. L'esito SHALL essere cercato anche
nella copia secondaria prima di dichiararlo assente. Un'azione FALLITA SHALL
leggersi come fallita.

Gli argomenti lunghi SHALL essere TAGLIATI dicendolo; oltre un tetto di azioni
SHALL essere detto QUANTE restano fuori, e il TOTALE SHALL restare dichiarato.

Anche SENZA prove SHALL restare la dichiarazione esplicita che il modello NON ha
strumenti in questo giro, e con le prove il VINCOLO SHALL venire PRIMA di esse.
SHALL essere detto esplicitamente di non FINGERE una chiamata.

#### Scenario: un'azione senza esito registrato
- **GIVEN** una chiamata di cui non si conosce l'esito
- **THEN** SHALL essere dichiarata muta, non data per riuscita

#### Scenario: nessuna azione da riportare
- **GIVEN** un turno senza strumenti
- **THEN** SHALL restare la dichiarazione che non ce ne sono

### Requirement: CHAT-STREAM-01 — Uno stream ORFANO si spegne da solo, e non tocca chi è vivo

Un turno il cui segnale di fine NON è mai arrivato — la connessione è caduta in
mezzo — SHALL essere riconosciuto e SPENTO: senza, l'indicatore resta acceso fino
al guardiano dei minuti lunghi o a un ricaricamento.

La riconciliazione SHALL richiedere PIÙ mancanze CONSECUTIVE, non una sola: una
sola assenza è una corsa, non una diagnosi. Uno stream che RIAPPARE SHALL azzerare
il conto.

Una sessione che il server dichiara ancora viva NON SHALL MAI essere considerata
orfana, e un invio LOCALE ancora in volo NON SHALL essere toccato nemmeno se il
server non lo conosce.

#### Scenario: la prima mancanza
- **GIVEN** un solo giro senza lo stream
- **THEN** NON SHALL essere spento

#### Scenario: un invio locale in volo
- **GIVEN** un invio non ancora noto al server
- **THEN** NON SHALL essere toccato

### Requirement: CHAT-SCROLL-01 — Il bersaglio di un salto SCADE, e un contesto parziale non lo fa esplodere

Il bersaglio di un salto a un messaggio SHALL poter essere LETTO senza
consumarlo, e CONSUMATO esplicitamente. Registrare di nuovo SHALL sostituire il
bersaglio precedente di quel discorso.

Il bersaglio SHALL SCADERE dopo un tempo; una volta RAGGIUNTO SHALL sopravvivere
una finestra di grazia breve e poi sparire, e un secondo raggiungimento NON SHALL
estendere quella finestra.

Il modulo SHALL funzionare anche con un ambiente PARZIALE: verificare che un
oggetto globale esista non basta, perché altri banchi ne installano versioni
incomplete — il risultato dipendeva da QUALI file giravano insieme, con la suite
intera verde e un sottoinsieme rosso.

#### Scenario: un contesto senza il metodo che serve
- **GIVEN** un ambiente parziale
- **THEN** la registrazione SHALL riuscire senza sollevare

#### Scenario: un bersaglio già raggiunto
- **GIVEN** un secondo raggiungimento
- **THEN** la finestra di grazia NON SHALL essere estesa

### Requirement: CHAT-WAIT-02 — Il numero grande è il LAVORO, e mentre aspetta sta FERMO

Il numero mostrato come durata di un turno SHALL essere il LAVORO, cioè il turno
MENO le attese: dieci minuti di turno di cui nove e mezzo di pausa erano un numero
vero e inutile — scorreva mentre si legge una domanda, mettendo fretta senza
informare.

Mentre si aspetta il numero NON SHALL crescere. A domanda chiusa SHALL tornare al
lavoro con le attese SOTTRATTE, e più attese nello stesso turno SHALL SOMMARSI,
compresa quella aperta. Un'attesa più lunga del turno SHALL dare lavoro ZERO, mai
negativo. Numeri sporchi NON SHALL produrre numeri sporchi.

Un turno che va avanti da molto SHALL dichiararlo: l'istante dell'ultimo strumento
si azzera a ogni chiamata, e da solo diceva pochi secondi a un turno che durava
da venti minuti. Quando l'inizio del turno NON è noto — il server è ripartito a
metà — il numero SHALL essere dichiarato APPROSSIMATO: è un MINIMO, non la verità.

Sotto il minuto i SECONDI sono l'informazione: un pavimento a un minuto mostrava
un minuto a un turno di tre secondi, proprio dove il numero serve più preciso.
Sopra il minuto SHALL tornare il formato compatto, e NON SHALL essere mostrato
uno zero.

L'istante attuale SHALL arrivare come ARGOMENTO: è ciò che impedisce a queste
funzioni di congelarsi, e le tre copie che hanno sostituito lo leggevano dentro il
disegno.

Per ogni soggetto SHALL esserci UNA sola voce di tempo: o lavora, o ha finito.

#### Scenario: mezz'ora di attesa dentro il turno
- **GIVEN** un turno lungo con una lunga attesa
- **THEN** il numero SHALL essere il solo lavoro

#### Scenario: l'inizio del turno non è noto
- **GIVEN** un server ripartito a metà turno
- **THEN** il numero SHALL essere dichiarato approssimato

### Requirement: CHAT-TOOL-05 — Un corpo lungo si taglia DICENDOLO, e la misura resta quella vera

Il corpo di una scheda di strumento SHALL essere TAGLIATO oltre un budget, e il
taglio SHALL essere DICHIARATO. La lunghezza REALE SHALL restare disponibile: è
la differenza fra «questo è tutto» e «questo è quanto te ne mostro».

Un corpo ESATTAMENTE al budget NON SHALL essere considerato in eccesso.

Chi chiama SHALL poter imporre il proprio budget.

Le misure in byte SHALL cambiare unità a soglie coerenti.

#### Scenario: un corpo esattamente al budget
- **GIVEN** una lunghezza pari al limite
- **THEN** NON SHALL essere dichiarato tagliato

#### Scenario: un corpo oltre il budget
- **GIVEN** una lunghezza superiore
- **THEN** SHALL essere tagliato, e la lunghezza vera SHALL restare

### Requirement: CHAT-BUBBLE-03 — Fermare un turno PRIMA che dicesse qualcosa non lascia una bolla vuota

Fermare una risposta PRIMA che il modello abbia prodotto qualcosa SHALL SCARTARE
il segnaposto creato all'inizio, non finalizzarlo: finalizzato produce una bolla
VUOTA che sopravvive a ogni ricaricamento — nel database se ne contavano decine
nei giorni di lavoro intenso.

Mezza frase È lavoro: la bolla SHALL restare, finalizzata. Anche il solo
RAGIONAMENTO conta, e una chiamata di strumento fatta è roba fatta anche senza una
parola scritta.

Scartare una RIGENERAZIONE SHALL rimettere il ramo attivo su quello buono: nessun
puntatore appeso.

#### Scenario: si ferma prima della prima parola
- **GIVEN** nessun contenuto prodotto
- **THEN** il segnaposto SHALL essere scartato

#### Scenario: solo una chiamata di strumento
- **GIVEN** nessun testo ma uno strumento eseguito
- **THEN** la bolla SHALL restare

### Requirement: CHAT-COMPACT-02 — Il riassunto della compattazione si SEPARA dalla prosa

Il corpo di un messaggio che porta il riepilogo automatico della compattazione
SHALL essere spezzato in due: la prosa vera, che resta visibile, e il riepilogo,
che diventa richiudibile. È il cancello che tiene ventiquattro chilobyte di
riepilogo fuori dalla conversazione.

Un messaggio interamente di riepilogo SHALL lasciare la prosa VUOTA e il riepilogo
intero. Prosa seguita dal riepilogo SHALL produrre entrambi, ciascuno per intero.

Senza preambolo il testo SHALL passare INTATTO e il riepilogo SHALL essere assente
— non una stringa vuota, che è un riquadro richiudibile senza niente dentro. Un
testo vuoto NON SHALL produrre nessun riepilogo.

#### Scenario: un messaggio tutto di riepilogo
- **GIVEN** un corpo che è solo il riepilogo
- **THEN** la prosa SHALL essere vuota e il riepilogo SHALL essere il testo

#### Scenario: un messaggio normale
- **GIVEN** un corpo senza riepilogo
- **THEN** SHALL passare intatto, senza riepilogo

### Requirement: THINK-05 — La frase di attesa non tremola

La frase mostrata mentre il turno lavora SHALL dipendere SOLO dal tempo trascorso:
lo stesso tempo SHALL dare sempre la stessa frase, così l'indicatore non tremola né
si rimescola quando l'interfaccia si ridisegna.

SHALL partire dalla prima frase e tenerla per tutta la prima finestra, avanzare di
UN passo per finestra, e ricominciare dopo l'ultima.

Un tempo non valido — negativo, non numerico, infinito, come può produrlo un
istante sbagliato o futuro — SHALL degradare alla prima frase, non a un indice
fuori elenco.

L'insieme delle frasi SHALL essere non banale e privo di voci vuote.

#### Scenario: lo stesso tempo trascorso
- **GIVEN** due letture allo stesso istante trascorso
- **THEN** SHALL dare la stessa frase

#### Scenario: un istante futuro
- **GIVEN** un tempo trascorso negativo
- **THEN** SHALL essere mostrata la prima frase

### Requirement: CLEAR-01 — Lo svuotamento rapido vale solo dove non c'è niente da perdere

Lo svuotamento SHALL essere permesso su un thread del tutto vuoto, su quello col
SOLO primo messaggio della persona, e col SEGNAPOSTO vuoto — che è il caso per cui
la scorciatoia esiste.

SHALL essere RIFIUTATO quando l'assistente ha prodotto qualcosa, e in particolare
su un turno AGENTICO: nessuna prosa, ma strumenti eseguiti è lavoro. SHALL essere
rifiutato su un SECONDO turno della persona — è la regressione che cancellava la
cronologia — e su un thread lungo.

SHALL essere rifiutato quando la sessione ha righe FUORI dal ramo attivo: ciò che
non si vede da qui è comunque roba.

Un conteggio di sessione che COINCIDE col ramo attivo NON SHALL cambiare niente, e
un conteggio PIÙ PICCOLO del ramo attivo NON SHALL fingere righe nascoste.

Un turno della persona con due risposte dell'assistente — cioè due rami — SHALL
essere rifiutato.

#### Scenario: un turno agentico senza prosa
- **GIVEN** un turno che ha eseguito strumenti senza scrivere
- **THEN** lo svuotamento SHALL essere rifiutato

#### Scenario: righe fuori dal ramo attivo
- **GIVEN** una sessione con rami non visibili da qui
- **THEN** lo svuotamento SHALL essere rifiutato

### Requirement: EMPTYTURN-01 — Un turno che non ha prodotto niente non resta in chat

Il segnaposto appena creato SHALL essere riconosciuto VUOTO — è la riga che
restava in chat quando si premeva stop subito — e lo SPAZIO BIANCO NON SHALL
valere contenuto.

SHALL essere TENUTO tutto ciò che è lavoro: mezza frase, il solo ragionamento
senza testo, una chiamata a uno strumento anche senza testo, dei blocchi, dei
media. Array serializzati VUOTI SHALL valere quanto l'assenza.

**Una colonna ILLEGGIBILE NON SHALL essere scambiata per vuota**: nel dubbio si
tiene, perché cancellare è irreversibile.

Un messaggio della persona NON SHALL passare da qui.

Le sentinelle che la riga di comando emette al posto di una risposta — la frase
che dice che nessuna risposta era richiesta, e quella che dichiara nessun
contenuto — SHALL valere VUOTO, spazi attorno compresi. Ma se quel turno ha
prodotto LAVORO SHALL restare, e PARLARE di una sentinella NON SHALL essere
emetterla.

#### Scenario: il segnaposto dopo uno stop immediato
- **GIVEN** un turno interrotto prima di qualunque contenuto
- **THEN** SHALL essere riconosciuto vuoto

#### Scenario: una colonna illeggibile
- **GIVEN** un contenuto che non si riesce a interpretare
- **THEN** NON SHALL essere trattato come vuoto

### Requirement: LEAN-01 — La stessa stringa non si scrive due volte sulla riga

Il risultato di una chiamata SHALL essere lasciato cadere quando il dettaglio
porta GIÀ la stessa identica stringa, anche quando la copia sta un livello più
sotto.

SHALL essere TENUTO quando il dettaglio dice qualcos'altro — una conferma non è il
contenuto — quando la copia è solo un PEZZO e non il tutto, e quando il dettaglio
MANCA, perché lì è il risultato la ricaduta di chi disegna.

NON SHALL essere guardato oltre il secondo livello: una copia troppo in fondo NON
autorizza il taglio.

Un risultato vuoto o non testuale SHALL essere lasciato stare, e senza niente da
togliere SHALL tornare lo STESSO riferimento — così chi confronta per identità non
ridisegna.

Dentro i blocchi SHALL valere la stessa regola, e il resto del blocco NON SHALL
muoversi. L'originale NON SHALL essere mutato.

Sulla riga scritta a disco il testo duplicato SHALL comparire UNA volta sola, la
colonna assente SHALL restare assente — e assente NON SHALL diventare vuoto — e
NIENTE SHALL andare perso: un risultato che non è una copia resta.

La rilettura SHALL prendere il risultato quando c'è, e il campo di testo del
dettaglio quando non c'è.

#### Scenario: la copia sta tre livelli sotto
- **GIVEN** una copia oltre il secondo livello
- **THEN** il risultato NON SHALL essere tagliato

#### Scenario: niente da togliere
- **GIVEN** una chiamata senza duplicati
- **THEN** SHALL tornare lo stesso riferimento

### Requirement: COMPACT-DIV-01 — Il separatore sopravvive alla riga che lo portava

Da quando la compattazione chiude davvero il proprio turno, quel turno finalizza
una riga dell'assistente COMPLETAMENTE VUOTA: una compattazione non produce
testo, e il suo esito è il separatore, che vive in una tabella sua.

La riga vuota SHALL essere SCARTATA, e il marcatore SHALL RI-ANCORARSI al
messaggio precedente: scartare la riga senza ri-ancorare il marcatore perde il
separatore, che è l'unica cosa che quel turno ha prodotto.

Un turno di compattazione che HA prodotto qualcosa NON SHALL essere scartato.

#### Scenario: una compattazione senza testo
- **GIVEN** un turno di sola compattazione
- **THEN** la bolla SHALL sparire e il separatore SHALL restare

#### Scenario: una compattazione con del testo
- **GIVEN** un turno che ha prodotto contenuto
- **THEN** NON SHALL essere scartato

### Requirement: MSGOWN-01 — Ogni scrittore possiede i PROPRI campi, e non sbianca quelli degli altri

Il difetto: la conversazione scorreva e poi il messaggio spariva. La causa era
una scrittura condivisa che sovrascriveva testo, ragionamento e strumenti DIRETTAMENTE,
e ogni scrittore li ri-persisteva TUTTI dalla propria istantanea — così la
scrittura di un risultato di strumento cancellava il testo appena trasmesso.

Una scrittura di RISULTATO NON SHALL MAI sbiancare il testo trasmesso, e una
scrittura di TESTO NON SHALL sbiancare lo stato degli strumenti. La finalizzazione
SHALL preservare entrambi — mai una bolla vuota — e una scrittura di solo
controllo NON SHALL sbiancare il corpo.

La chiusura del flusso SHALL marcare uno strumento rimasto appeso, SHALL lasciare
intatti quelli già conclusi, e SHALL SPEGNERE anche una domanda rimasta a
schermo: un pannello vivo su un turno morto promette una risposta che non arriverà.

Un marcatore di scadenza SHALL scrivere il testo PRESERVANDO la cronologia degli
strumenti. Un turno di SOLI blocchi NON SHALL essere scartato come vuoto.

Un turno SPONTANEO SHALL riprendere il cartello che lo precede: la stessa bolla,
col corpo pulito e il turno vivo. Una risposta VERA NON SHALL toccarlo: SHALL
nascere una riga NUOVA. Un turno che aveva prodotto degli strumenti NON SHALL
essere riusato. Su una sessione vuota SHALL essere creato e basta.

Alla riadozione dopo un ricaricamento SHALL essere RIUSATA la riga parziale
sopravvissuta, IN PLACE, conservandone il corpo e ricostruendo pulito — nessun
turno doppio, nessun fantasma. Se la gamba di riadozione muore prima di
finalizzare, la riga SHALL restare com'era. Un replay MUTO NON SHALL portare via
il pannello. Quando NIENTE è sopravvissuto — l'ultimo messaggio è già finalizzato,
o la sessione è vuota — SHALL essere creata una riga NUOVA.

#### Scenario: un risultato di strumento durante lo streaming
- **GIVEN** una scrittura di risultato mentre il testo arriva
- **THEN** il testo NON SHALL essere sbiancato

#### Scenario: una riadozione che muore prima di finalizzare
- **GIVEN** la gamba interrotta
- **THEN** la riga SHALL restare com'era

### Requirement: HISTBUILD-01 — La storia consegnata al fornitore è quella ATTIVA, senza i turni a metà

La storia SHALL essere costruita dal ramo ATTIVO persistito, come una sequenza
senza stato, e SHALL restituire un elenco VUOTO quando non ci sono messaggi.

SHALL essere ESCLUSO ciò che non è una risposta: i turni PARZIALI ancora in volo,
le buste di contesto, e i messaggi che restano vuoti dopo la ripulitura.

L'esclusione dell'ULTIMO SHALL funzionare — così il turno appena aggiunto non
viene duplicato — e su un ingresso vuoto SHALL essere un non-fare, senza cadere.

Il limite SHALL tenere i turni PIÙ RECENTI, e insieme all'esclusione dell'ultimo
SHALL prima escludere e poi limitare: l'ordine inverso taglia un turno in più.

L'ORDINE SHALL essere preservato attraverso tutti i filtri.

#### Scenario: un turno parziale in volo
- **GIVEN** una risposta ancora in streaming
- **THEN** NON SHALL entrare nella storia

#### Scenario: limite ed esclusione dell'ultimo insieme
- **GIVEN** entrambi richiesti
- **THEN** SHALL essere prima escluso l'ultimo, poi applicato il limite

### Requirement: CHAT-COMPACT-03 — Il riepilogo si RICHIUDE, e la prosa prima resta visibile

Nell'interfaccia il riepilogo automatico della compattazione SHALL essere
RICHIUSO, la prosa che lo precede SHALL restare VISIBILE, e il riepilogo SHALL
espandersi al gesto.

#### Scenario: un messaggio con prosa e riepilogo
- **GIVEN** un turno che porta entrambi
- **THEN** la prosa SHALL restare visibile e il riepilogo SHALL essere richiuso

### Requirement: CHAT-COMPACT-04 — Il contesto pieno non uccide la chat

Una conversazione che riempie la finestra del modello SHALL continuare a
rispondere. Il rifiuto «prompt is too long» NON SHALL essere trattato come un
guasto del provider: porta con sé il conteggio ESATTO dei token di una
richiesta che abbiamo mandato noi, e quel numero SHALL essere usato per
correggere la stima e rifare il turno da solo.

La stima dei token NON SHALL restare un'assunzione. Il rapporto fra caratteri e
token SHALL essere CALIBRATO su quanto l'interfaccia del modello dichiara di
aver contato, e un rapporto misurato NON SHALL mai essere più generoso di
quello assunto: dichiarare più spazio di quanto ce ne sia è l'errore che uccide
la conversazione, mentre dichiararne di meno costa solo una compattazione
anticipata.

La compattazione SHALL alleggerire anche gli ARGOMENTI delle chiamate vecchie,
non i soli risultati: il risultato di una scrittura è una riga, il suo
argomento è il file intero.

Quando alleggerire non basta a raggiungere il bersaglio, i turni PIÙ VECCHI
SHALL essere tagliati, così che una compattazione non possa dichiararsi
riuscita lasciando una richiesta che l'interfaccia rifiuta. La richiesta
iniziale SHALL sopravvivere, con l'indicazione di quanto è stato tolto.

Mentre tutto questo accade la chat SHALL dirlo con una frase leggibile, e la
resa — se dopo un numero limitato di tentativi la conversazione ancora non
entra — SHALL spiegare cosa fare, non mostrare il corpo dell'errore.

#### Scenario: il contesto pieno non uccide la chat
- **GIVEN** una conversazione che sfora il tetto della finestra
- **WHEN** l'interfaccia del modello rifiuta la richiesta perché troppo lunga
- **THEN** la conversazione SHALL essere compattata sul conteggio dichiarato
- **AND** il turno SHALL ripartire da solo e ricevere una risposta
- **AND** in chat SHALL comparire una frase leggibile, non un errore di rete

#### Scenario: la stima si corregge da sola
- **GIVEN** un giro concluso di cui si conosce il prompt contato
- **THEN** la soglia SHALL essere valutata su quel rapporto misurato

#### Scenario: quando non si sblocca
- **GIVEN** una conversazione che non entra nemmeno dopo le ricompattazioni
- **THEN** SHALL essere detto cosa fare, e NON SHALL essere ritentato all'infinito

### Requirement: DURAB-CHAT-01 — Cosa sopravvive a un ricaricamento, e cosa DEVE non sopravvivere

Questo repo misura il peso del pacchetto, la latenza delle rotte, i fotogrammi
chiesti a riposo e i millisecondi fra il gesto e l'inchiostro. Nessuna di quelle
misure dice se, ricaricando, si ritrova il lavoro dov'era.

Il TESTO non ancora spedito del campo di scrittura SHALL restare, e un ALLEGATO
SHALL restare insieme al testo che lo accompagna.

**La posizione di scorrimento della chat NON SHALL restare**, ed è una decisione
dichiarata: ricaricando si torna dove la conversazione è ADESSO, non dove si stava
leggendo.

#### Scenario: testo e allegato non spediti
- **GIVEN** un ricaricamento della pagina
- **THEN** entrambi SHALL essere ancora lì

#### Scenario: la posizione di scorrimento
- **GIVEN** un ricaricamento
- **THEN** NON SHALL essere ripristinata

### Requirement: CHAT-MEDIA-01 — Un'immagine si disegna DOVE è dichiarata, e il marcatore non si legge mai

Un allegato viaggia dentro il testo di un messaggio come marcatore
(`MEDIA:<percorso>`, e le due forme `[Attached file: …]` / `[Voice message: …]`).
Il sistema SHALL trasformare ogni marcatore in un media NEL PUNTO in cui compare
nel testo, e SHALL NOT mostrare all'utente il marcatore come prosa.

Il vincolo di posizione è una regola sola e senza casi particolari, ed è ciò che
rende possibili due cose diverse con lo stesso meccanismo: quello che il server
appende a fine turno (`updateLastMessageWithMedia`: una scansione di
`~/.topics/media` per `mtime`, che nessun agente ha dichiarato) sta in coda
all'ultimo blocco, quindi esce in coda; quello che un agente scrive in mezzo
alla propria risposta esce in mezzo, che è l'unico modo di mostrare
un'immagine nel momento in cui serve.

Il messaggio SHALL essere ripulito sulla superficie che viene DIPINTA. Un
messaggio con timeline si disegna dai `blocks`, non da `content`: pulire solo
`content` lascia il marcatore a schermo pur avendo la galleria giusta.

Una superficie SHALL NOT disegnare due volte lo stesso media: ciò che i blocchi
hanno già reso in linea non torna nella galleria di coda.

#### Scenario: il marcatore appeso dal server a fine turno
- **GIVEN** un turno che ha prodotto due immagini in `~/.topics/media`
- **AND** il server le ha appese in coda all'ultimo blocco di testo del messaggio
- **WHEN** il messaggio viene disegnato
- **THEN** le due immagini compaiono in fondo al messaggio
- **AND** nessun percorso `MEDIA:` è leggibile come testo

#### Scenario: l'agente mostra un'immagine a metà del discorso
- **GIVEN** un blocco di testo che dice «prima era così», poi un marcatore, poi «e dopo così», poi un secondo marcatore, poi una conclusione
- **WHEN** il messaggio viene disegnato
- **THEN** le parti si susseguono nell'ordine scritto: prosa, immagine, prosa, immagine, prosa
- **AND** nessuna delle due immagini viene rimandata in fondo

#### Scenario: un blocco che contiene SOLO marcatori
- **GIVEN** un blocco di testo formato dal solo marcatore di un'immagine
- **WHEN** il messaggio viene disegnato
- **THEN** l'immagine compare
- **AND** non resta una bolla di testo vuota al suo posto

#### Scenario: una parola che comincia per MEDIA non è un marcatore
- **GIVEN** un messaggio che nomina un identificatore come `MEDIALIBRARY`
- **WHEN** il messaggio viene disegnato
- **THEN** la parola resta nel testo intatta
- **AND** non viene creato nessun media

### Requirement: NATIVE-CTX-01 — il runtime nativo riceve le regole globali dell'utente

Quando un turno è servito dal provider `topics` e `~/.claude/CLAUDE.md` esiste, il
contesto DEVE contenerne il testo, con un livello di import `@percorso` espanso. Con
qualunque altro provider quel blocco NON DEVE essere inviato (la CLI lo carica da sé).

#### Scenario: le regole arrivano al nativo
- **GIVEN** un topic sul provider `topics` e un `~/.claude/CLAUDE.md` che contiene «trash > rm»
- **WHEN** l'utente manda un messaggio
- **THEN** il modello può citare quella regola senza usare tool

#### Scenario: non si paga due volte su claude-code
- **GIVEN** un topic sul provider `claude-code`
- **WHEN** si assembla il payload
- **THEN** il blocco `user:CLAUDE.md` non compare fra gli slot inviati

### Requirement: NATIVE-SKILL-01 — elenco in contesto, corpo a richiesta

Il contesto di un turno nativo DEVE elencare le skill installate (nome + descrizione,
descrizione troncata a 180 caratteri) e NON DEVE contenerne il corpo. Il corpo si ottiene
col tool `skill`, che accetta solo nomi validi e risolti dentro le cartelle note.

#### Scenario: una skill dietro un symlink è installata
- **GIVEN** `~/.claude/skills/x` è un link a una cartella con dentro `SKILL.md`
- **THEN** `x` compare nell'elenco

#### Scenario: il tool rifiuta un nome che esce dalle cartelle note
- **WHEN** si chiama `skill` con `../../../etc/passwd`
- **THEN** torna un errore leggibile, non il contenuto di un file

### Requirement: NATIVE-EFFORT-01 — l'effort del topic diventa thinking

Un turno nativo DEVE tradurre l'effort (topic, altrimenti impostazione globale) in
`thinking.budget_tokens`, e `max_tokens` DEVE restare maggiore del budget. L'effort
`low` NON DEVE abilitare il thinking.

Dal 03/09/2026 la traduzione dipende dalla GENERAZIONE del modello: sulla
famiglia 5 (e su Opus e Sonnet 4.6 e successivi) l'effort viaggia come
`thinking: {type: "adaptive"}` più `output_config.effort`, senza
`budget_tokens`, e `low` resta un pensiero; la tabella dei budget vale per i
modelli precedenti, dove `low` continua a non abilitare il thinking. La forma
del corpo della richiesta è NATIVE-SHAPE-01.

#### Scenario: high
- **GIVEN** effort `high`
- **THEN** la richiesta porta un budget di thinking > 1024 e `max_tokens` > budget

### Requirement: NATIVE-SHAPE-01 — What the native loop puts in the request body

The request the native runtime sends to the API SHALL carry, when nobody set an
output cap, a `max_tokens` equal to the CLI catalogue default (64000), not half
of it. A cap passed by the caller SHALL be honoured. On a model that takes a
thinking budget the cap SHALL be raised above the budget, and the budget SHALL
NOT be cut to fit the cap.

The model id SHALL reach the API bare: the `[1m]` suffix is a convention of
this app for the long window and SHALL be stripped before the request leaves,
the thinking configuration being decided on the bare id.

A tool result SHALL enter the history cut to a head and a tail, with a notice
between them that says how many characters were left out and how to read a
slice, so that two large reads in one round cannot push the context past its
window and repeat the same 400 on every later turn of the session.

> **Why.** None of this was visible from the outside, because the body was
> never asserted on, only the stream that came back. Measured on 2026-09-03: a
> `max_tokens` of 16384 meant a single `write_file` above ~16k tokens of output
> could never succeed here while it did on the CLI; the effort tier became a
> fixed `budget_tokens` for EVERY model, which the 5 family rejects; two 400k
> reads in one round were enough to push a 200k window past its limit for the
> rest of the session.

#### Scenario: no cap set
- **GIVEN** a turn with no `maxTokens` option
- **THEN** the body carries `max_tokens: 64000`

#### Scenario: a cap under the thinking budget
- **GIVEN** a legacy model, effort `high` and a caller cap of 8000
- **THEN** the body carries the 10000-token budget and a `max_tokens` above it

#### Scenario: the long window
- **GIVEN** the model `claude-sonnet-5[1m]`
- **THEN** the body names `claude-sonnet-5` and its thinking is `adaptive`

#### Scenario: a huge tool result
- **GIVEN** a `read_file` whose output exceeds the per-result budget
- **THEN** the history holds its head and its tail, with the omission notice between them

### Requirement: CODEX-MODEL-01 — A Codex turn never inherits a model the account cannot use

When a Codex turn names no model, and the default in `~/.codex/config.toml` is
not in the account's model catalog, the turn SHALL name the first model the
catalog lists instead. With an empty catalog the CLI's own default SHALL stand.

> **Why.** On 2026-09-23 `config.toml` said `gpt-6-sol`, absent from the
> account's catalog, and every Topics turn without an explicit model died with
> 400 "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT
> account".

#### Scenario: stale default
- **GIVEN** `model = "gpt-6-sol"` and a catalog of `gpt-6-astra`, `gpt-5.5`
- **THEN** the turn runs with `--model gpt-6-astra`

### Requirement: NATIVE-UA-01 — The native runtime declares a CLI version the API accepts

The `user-agent` the native runtime sends to Anthropic, on messages and on the
OAuth refresh, SHALL name the highest Claude Code version installed on the
machine, and SHALL never name one below the floor known to be accepted by every
current default model.

> **Why.** The API enables models by the CLI version the user-agent declares.
> It was a literal `claude-cli/2.1.0`, and on 2026-09-23 `claude-opus-5-5`, the
> default, answered 400 "Claude Code 2.1.0 does not support this model; version
> 2.1.280 or newer is required", while 2.1.280 got a 200 on the same token.

#### Scenario: no CLI installed
- **GIVEN** no `~/.local/share/claude/versions` directory
- **THEN** the user-agent names the floor version

#### Scenario: a newer CLI installed
- **GIVEN** versions `2.1.280` and `2.1.1000` installed
- **THEN** the user-agent names `2.1.1000`

### Requirement: CHAT-NTOOL-01 — Il piano del turno esiste anche senza la CLI

Il runtime nativo SHALL offrire uno strumento per scrivere la lista di cose da
fare del turno, e SHALL emetterlo nella forma che il client già disegna: una
chiamata di nome `todo_write` che porta `todos` come elenco di
`{ content, status, activeForm? }` con `status` in `pending | in_progress |
completed`. La chiamata NON SHALL toccare il disco né eseguire alcunché: il suo
risultato è la lista nel trascritto, da cui discendono la card e la striscia
appiccicata sopra il compositore (TODO-01).

Lo strumento SHALL rifiutare una forma che renderebbe una card vuota o muta
(elenco assente o vuoto, `content` vuoto, `status` sconosciuto) con un messaggio
che nomina il valore ricevuto e i valori buoni. SHALL rispondere, quando accetta,
con il conteggio per stato. Più di un passo `in_progress` SHALL essere segnalato
e NON SHALL essere rifiutato.

Lo strumento SHALL essere concesso anche al livello di autonomia `ask`: quella
modalità chiede di proporre un piano, e negarle lo strumento del piano lo
ridurrebbe a prosa che nessuna parte dell'interfaccia mostra.

La MISURA di questa requirement è la striscia sopra il compositore: su una
sessione nativa che sta lavorando a un compito di tre o più passi, deve essere
piena come su una sessione CLI, non vuota.

#### Scenario: La lista arriva alla striscia, non solo al trascritto
- **GIVEN** una chat servita dal runtime nativo
- **WHEN** il modello chiama `todo_write` con tre voci, una `in_progress`
- **THEN** la chiamata è riconosciuta come `detail.type = 'todo'` al confine
  dello stream (nessun JSON grezzo a schermo)
- **AND** la striscia sopra il compositore mostra la voce in corso e il conteggio

#### Scenario: Una lista che renderebbe una card vuota non passa
- **GIVEN** un turno nativo
- **WHEN** il modello chiama `todo_write` con `todos: []`, oppure con una voce
  dal `content` vuoto
- **THEN** il risultato è un errore leggibile, non una card vuota in chat
- **AND** il turno prosegue (l'errore torna come risultato del tool, non come
  eccezione)

#### Scenario: Uno stato inventato dice quali sono quelli buoni
- **GIVEN** un turno nativo
- **WHEN** una voce arriva con `status: "quasi"`
- **THEN** il messaggio d'errore nomina `"quasi"` e i tre stati ammessi
- **AND** nessuna parte della lista viene mostrata a metà

#### Scenario: Due passi in corso si segnalano, non si rifiutano
- **GIVEN** un turno nativo
- **WHEN** la lista arriva con due voci `in_progress`
- **THEN** la lista è accettata e mostrata
- **AND** il risultato contiene la nota che ne va tenuta una sola

#### Scenario: In «chiedi prima» il piano si scrive lo stesso
- **GIVEN** una topic con autonomia `ask`
- **WHEN** il modello chiama `todo_write`
- **THEN** la chiamata è consentita
- **AND** `write_file`, `edit_file` e `bash` restano rifiutati nello stesso turno

### Requirement: CHAT-NTOOL-02 — Un URL diventa testo leggibile, o una spiegazione

Il runtime nativo SHALL offrire uno strumento che scarica un URL e ne restituisce
il contenuto in una forma che valga i token che costa. HTML SHALL essere
convertito in markdown conservando titoli con il loro livello, elenchi come
righe, blocchi di codice con la loro indentazione e link con l'indirizzo risolto
in assoluto sulla pagina di partenza; JSON SHALL essere restituito indentato;
testo semplice intatto.

Lo strumento SHALL accettare soltanto `http` e `https`, e SHALL rifiutare ogni
altro schema PRIMA di qualunque accesso: `file:` e `data:` sarebbero una lettura
di disco arbitraria dentro un livello in cui gli strumenti di file sono murati
nella workspace. SHALL leggere il corpo con un tetto MENTRE arriva, senza mai
materializzare in memoria una risposta di dimensione arbitraria. SHALL avere un
limite di tempo, e SHALL interrompersi quando il turno viene annullato.

Ciò che non è testo SHALL essere NOMINATO (tipo e dimensione) invece di essere
restituito al modello. Una risposta di errore HTTP SHALL portare lo stato E il
corpo della spiegazione del server. Una pagina il cui contenuto è costruito in
JavaScript SHALL dichiarare che non c'è testo leggibile e perché, invece di
tornare vuota.

Lo strumento SHALL essere concesso anche al livello `ask`: è una GET senza corpo,
non scrive niente, ed è ciò che serve per proporre un piano invece di indovinarlo.

#### Scenario: Una pagina di documentazione arriva come markdown
- **GIVEN** un turno nativo
- **WHEN** il modello chiama `web_fetch` su una pagina HTML con titolo, elenco e
  un link relativo
- **THEN** il risultato contiene il titolo, i titoli interni con il loro livello
  e una riga per voce di elenco
- **AND** il link porta il suo indirizzo assoluto (seguibile con una seconda
  chiamata)
- **AND** il contenuto di `<script>` e `<style>` non compare

#### Scenario: Uno schema che uscirebbe dal perimetro non tocca la rete né il disco
- **GIVEN** un turno nativo, a qualunque livello di autonomia
- **WHEN** il modello chiama `web_fetch` con `file:///etc/passwd`
- **THEN** la chiamata è rifiutata prima di aprire alcunché
- **AND** il messaggio dice quali schemi sono ammessi e quale strumento usare per
  un file locale

#### Scenario: Un binario è nominato, non riversato addosso al modello
- **GIVEN** un URL che risponde `image/png`
- **WHEN** il modello lo chiede con `web_fetch`
- **THEN** il risultato è un errore che nomina il tipo di contenuto
- **AND** nessun byte del binario entra nel contesto

#### Scenario: Un errore HTTP porta la spiegazione del server
- **GIVEN** un URL che risponde 401 con un corpo che spiega cosa manca
- **WHEN** il modello lo chiede
- **THEN** il risultato contiene lo stato e il testo della spiegazione
- **AND** è marcato come errore, così il modello non lo legge come contenuto

#### Scenario: Una pagina dipinta dal browser lo dichiara
- **GIVEN** un URL che risponde HTML senza testo (il contenuto lo costruisce uno
  script)
- **WHEN** il modello lo chiede
- **THEN** il risultato dice che non c'è testo leggibile e che questo strumento
  non esegue JavaScript
- **AND** il modello ha di che scegliere un'altra strada invece di ripetere la
  stessa chiamata

#### Scenario: Mezzo mega non entra in un contesto
- **GIVEN** un URL che risponde 500 kB di testo
- **WHEN** il modello lo chiede con un tetto di 5.000 caratteri
- **THEN** il risultato sta dentro il tetto e dichiara di essere troncato
- **AND** il resto della risposta non viene scaricato

#### Scenario: Un turno annullato non apre la connessione
- **GIVEN** un turno il cui segnale è già annullato (spegnimento o stop
  dell'utente)
- **WHEN** viene eseguito un `web_fetch`
- **THEN** nessuna richiesta parte
- **AND** il risultato dice che il turno è stato annullato, non che la rete è
  guasta

### Requirement: CHAT-NTOOL-03 — Uno strumento che a runtime fallisce NON si dichiara

Il runtime nativo NON SHALL dichiarare al modello strumenti che, sulla macchina
in cui gira, non possono funzionare. Uno strumento dichiarato è un invito a
usarlo: quando risponde «credenziale assente» costa due giri prima che il modello
si arrenda, e il turno esce peggiore che se lo strumento non fosse mai esistito.

In particolare, e finché le condizioni qui sotto non cambiano:

- **Ricerca web.** Il runtime NON SHALL offrire un `web_search` proprio finché non
  esiste una credenziale di ricerca risolvibile (chiave in Impostazioni o
  variabile d'ambiente documentata). La capacità NON è assente dal prodotto: la
  flotta MCP nativa monta i server configurati dall'utente, quindi un server di
  ricerca configurato arriva al modello come `mcp__<server>__<tool>` senza che
  questo repository conosca nessuna chiave.
- **Sub-agente.** Il runtime NON SHALL offrire un `task` finché non ha un turno
  annidato sicuro, cioè finché non esistono e non sono provati: un limite di
  PROFONDITÀ (distinto dal tetto dei giri, che vale dentro un turno solo), un
  BUDGET del figlio che rientra nel registro d'uso del padre, un CANALE verso
  l'interfaccia che alimenti la card del sub-agente (oggi ce l'ha solo lo stream
  della CLI), e la PROPAGAZIONE dell'annullamento dal padre al ciclo e ai tool
  del figlio.

#### Scenario: Nessuna credenziale, nessuno strumento di ricerca dichiarato
- **GIVEN** un'installazione senza credenziale di ricerca
- **WHEN** un turno nativo compone l'elenco degli strumenti
- **THEN** nessuno strumento di ricerca proprio compare fra quelli dichiarati
- **AND** il modello risolve la ricerca con gli strumenti MCP presenti, se ce ne
  sono

#### Scenario: Nessuna ricorsione spedita per sbaglio
- **GIVEN** un turno nativo
- **WHEN** il modello cerca uno strumento per delegare a un sub-agente
- **THEN** non lo trova
- **AND** il turno prosegue con gli strumenti che ci sono, invece di aprire un
  annidamento senza fondo, senza budget e invisibile in chat

### Requirement: CHAT-GOALLOOP-01 — `/goal` tiene la chat sull'obiettivo

Alla fine di un turno NON dispatchato, chiuso dal modello di sua iniziativa
(`end_turn`), se il topic ha un obiettivo `active` il sistema SHALL chiedere a un
giudice economico se l'obiettivo regge, e SHALL agire di conseguenza:

- `continue` → il server SHALL rimandare da solo un messaggio di continuazione
  allo stesso topic, per la STESSA via di una ripresa (`POST /api/chat`);
- `met` → il goal SHALL chiudersi `achieved` e i client SHALL riceverlo con
  `goal:updated`;
- `blocked_on_user` → il ciclo SHALL fermarsi lasciando l'obiettivo attivo: a
  farlo ripartire è il prossimo messaggio umano;
- risposta illeggibile → NON SHALL succedere niente, in silenzio.

Il ciclo SHALL avere questi freni, e ognuno SHALL essere verificabile da solo:
un tetto di continuazioni consecutive per goal; uno stop dopo due turni di fila
che non eseguono nessun tool; nessuna continuazione su un turno fermo su una
domanda all'utente o su un piano in attesa; nessuna continuazione sui turni
dispatchati dalla board, che hanno già il ciclo del dispatcher. Chiudere il goal
o fermare il ciclo dalla barra SHALL bastare a fermarlo.

I contatori del ciclo SHALL vivere sul goal nel database, non in memoria: un
tetto che si azzera al riavvio non è un tetto.

> **Perché.** Fino al 2026-09-03 `/goal` salvava l'obiettivo e lo re-iniettava a
> ogni turno, ma quando il turno finiva con l'obiettivo ancora aperto non
> succedeva niente: la chat si fermava, l'obiettivo restava sulla barra e nessuno
> lo perseguiva. Un lavoro lungo si interrompeva a metà senza prosieguo.

#### Scenario: Lavoro a metà, la chat prosegue da sola
- **GIVEN** un topic con un obiettivo attivo
- **WHEN** un turno finisce `end_turn` dicendo di aver fatto metà del lavoro
- **AND** il giudice risponde `continue`
- **THEN** parte un nuovo turno sullo stesso topic senza che nessuno scriva

#### Scenario: La continuazione non si spaccia per l'utente
- **GIVEN** una continuazione mandata dal server
- **THEN** la riga che apre il turno porta il marcatore della continuazione con
  il numero del tentativo
- **AND** in chat si vede come una riga di sistema compatta, non come una bolla
  dell'utente

#### Scenario: Obiettivo raggiunto
- **GIVEN** un topic con un obiettivo attivo
- **WHEN** un turno finisce e il giudice risponde `met`
- **THEN** il goal non è più attivo, il suo stato è `achieved`, e nessun turno
  nuovo parte

#### Scenario: C'è una domanda per l'utente
- **GIVEN** un topic con un obiettivo attivo
- **WHEN** il turno finisce con una domanda all'utente
- **THEN** nessun turno nuovo parte
- **AND** l'obiettivo resta attivo, in attesa

#### Scenario: Lavoro in background ancora vivo
- **GIVEN** un topic con un obiettivo attivo e un turno che finisce lasciando un Agent, un Bash o un Monitor in background
- **WHEN** il turno finisce `end_turn`, anche dopo aver usato tool
- **THEN** il giudice NON viene interrogato e nessun turno nuovo parte
- **AND** il turno che la CLI apre da sola quando quel lavoro riporta viene giudicato come ogni altro; se quel turno è vuoto e viene scartato, si giudica il turno rimasto in attesa
- **AND** se nessun turno finisce, il ciclo fa un check-in dopo 30, 60 e 120 minuti, come Claude Code, e poi aspetta il prossimo messaggio

Il tetto dei giri di tool per turno è una fine della MACCHINA, non del modello:
il turno che lo raggiunge SHALL finire con la causa `tool-budget`, e NON SHALL
essere trattato come un guasto del provider. Con un obiettivo attivo il giudice
SHALL essere interrogato come dopo un `end_turn`; senza obiettivo il server
SHALL riprendere da solo UNA volta, con la riga di ripresa marcata, e se anche
la ripresa esaurisce i giri SHALL fermarsi e scriverlo in chat. Misurato il
05/09/2026: un topic con obiettivo attivo e passo in corso è rimasto muto sei
ore perché il tetto arrivava come `provider-error` e il ciclo lo saltava.

#### Scenario: Il tetto dei giri di tool non ferma l'obiettivo
- **GIVEN** un topic con un obiettivo attivo
- **WHEN** il turno finisce perché ha esaurito i giri di tool del server
- **THEN** il giudice viene interrogato come dopo un `end_turn`
- **AND** un guasto vero del provider continua a non essere un candidato

#### Scenario: Senza obiettivo, il tetto riprende una volta e poi si ferma
- **GIVEN** un topic senza obiettivo, non dispatchato e senza domande in sospeso
- **WHEN** il turno finisce per il tetto dei giri di tool
- **THEN** il server rimanda da solo UN messaggio di ripresa, marcato come ripresa
- **AND** se anche quel turno finisce per il tetto, nessun altro parte e in chat compare l'avviso che la ripresa automatica è sospesa

#### Scenario: Il tetto si ferma e lo scrive
- **GIVEN** un goal che ha già speso tutte le continuazioni consecutive previste
- **WHEN** un turno finisce e il giudice risponde `continue`
- **THEN** nessun turno nuovo parte
- **AND** in chat compare una riga che dice che l'auto-continuazione si è fermata

#### Scenario: Nessun progresso
- **GIVEN** un goal attivo con il ciclo in corso
- **WHEN** due turni di fila finiscono senza eseguire nessun tool
- **THEN** il ciclo si ferma e in chat lo si legge

### Requirement: CHAT-GOALLOOP-02 — La barra dell'obiettivo mostra il ciclo

La barra dell'obiettivo SHALL mostrare lo stato del ciclo di auto-continuazione:
il numero di continuazioni spese quando ne ha spesa almeno una, «in attesa di te»
quando il ciclo si è fermato su una domanda, e un comando per fermarlo. Fermare
il ciclo NON SHALL chiudere l'obiettivo: l'obiettivo resta nel contesto di ogni
turno, semplicemente nessuno compra più turni per perseguirlo.

#### Scenario: Il conteggio si vede
- **GIVEN** un obiettivo attivo con due continuazioni spese
- **THEN** la barra mostra il numero delle continuazioni

#### Scenario: Fermare il ciclo non chiude l'obiettivo
- **GIVEN** un obiettivo attivo con il ciclo in corso
- **WHEN** si preme Ferma sulla barra
- **THEN** l'obiettivo è ancora attivo
- **AND** alla fine del turno successivo nessuna continuazione parte

### Requirement: CHAT-USERROW-01 — Una riga `user` scritta dalla macchina non è una bolla della persona

Le righe `user` che il dispatcher scrive per far partire o continuare un turno
(kickoff, ripresa, sollecito, continuazione dopo un'interruzione) SHALL essere
marcate ALLA FONTE come righe della macchina, e una riga `user` scritta dalla
persona NON SHALL portare nessun marchio: un marchio su ogni riga non direbbe
niente.

Il client SHALL rendere una riga marcata come cartiglio di sistema (piegato,
con il nome di chi l'ha scritta), NON come bolla della persona a destra con il
bottone di modifica: trecento righe di istruzioni della board in bocca alla
persona sono una bugia a schermo.

#### Scenario: la busta del dispatcher
- **GIVEN** un turno avviato dalla board con la sua busta
- **THEN** la riga `user` SHALL portare il marchio della macchina e SHALL comparire come cartiglio, non come bolla

#### Scenario: il messaggio della persona
- **GIVEN** una riga `user` scritta dalla persona nel composer
- **THEN** NON SHALL portare nessun marchio e SHALL restare una bolla

### Requirement: CHAT-PERSIST-01 — La riga di un turno non si riscrive per intero a ogni evento

Un turno in corso SHALL riscrivere la propria colonna `blocks` a intervalli
(ogni N eventi e a fine turno), non a ogni delta o evento di tool: il costo di
un turno in byte scritti SHALL crescere in modo lineare con i suoi eventi, non
quadratico.

Con `blocks` sulla riga, la colonna `tool_calls` NON SHALL essere scritta una
seconda volta: le chiamate di tool si leggono dalla timeline. Chi scrive la
timeline lo dichiara (`mirroredInBlocks`), invece di farlo indovinare alla riga.

#### Scenario: quindici eventi, poche scritture
- **GIVEN** un turno che riceve quindici eventi di tool
- **THEN** la colonna `blocks` SHALL essere riscritta un numero di volte limitato dall'intervallo, e per intero solo a fine turno

#### Scenario: nessuna seconda copia
- **GIVEN** una riga che porta `blocks`
- **THEN** `tool_calls` SHALL restare vuota e i tool SHALL essere letti dalla timeline

### Requirement: CHAT-INT-01 — Un turno interrotto dice perché, e offre una via d'uscita

Quando il sistema chiude un turno che non è arrivato in fondo, il messaggio SHALL
portare la CAUSA in forma strutturata (il blocco `error` con `cause`, lo stesso
vocabolario di `stream:end`, e l'istante `at`), non solo un testo appeso in
fondo alla prosa. Il client SHALL mostrare sopra il composer un banner
«Risposta interrotta», con la causa scritta nella lingua dell'interfaccia e un
comando che rimanda l'ultimo messaggio dell'utente. Il marcatore testuale in
`content` SHALL restare, come fallback per i client che non sanno leggere la
causa.

Il banner NON SHALL comparire quando il turno lo ha fermato la persona (`cause`
`user`: quel caso ha già il suo banner), quando il turno sta ancora rispondendo,
e su una riga senza `cause` (scritta prima che questo campo esistesse: assente
vuol dire «non attribuito», non «watchdog»).

#### Scenario: Il watchdog chiude un turno e il banner lo dice
- **GIVEN** un turno in corso che ha già scritto della prosa
- **WHEN** il watchdog lo chiude perché il processo del fornitore è morto
- **THEN** il messaggio porta un blocco `error` con `cause: "watchdog"` e l'istante
- **AND** sopra il composer compare il banner «Risposta interrotta» con la causa in chiaro

#### Scenario: Il turno si interrompe mentre lo si sta guardando
- **GIVEN** una chat aperta con un turno che sta rispondendo
- **WHEN** arriva la fine del turno con la causa (`stopCause`) e nessuno ricarica la pagina
- **THEN** il banner compare da sé, con la causa in chiaro
- **AND** la prosa già scritta resta al suo posto

#### Scenario: Una fine pulita non accende nessun banner
- **GIVEN** una chat aperta con un turno che sta rispondendo
- **WHEN** il turno finisce normalmente, senza causa di interruzione
- **THEN** nessun banner compare

#### Scenario: Il reaper d'inattività chiude un turno tagliato a metà risposta
- **GIVEN** un turno che ha già scritto una risposta lunga
- **WHEN** il reaper d'inattività lo chiude perché il processo figlio è morto
- **THEN** la prosa già scritta resta al suo posto
- **AND** in fondo alla sua timeline compare il verdetto con `cause: "watchdog"` e l'istante
- **AND** una seconda passata del reaper non aggiunge un secondo verdetto

#### Scenario: Una riga senza timeline non si riscrive
- **GIVEN** un turno chiuso dal reaper la cui timeline è vuota
- **THEN** il verdetto NON viene scritto nei blocchi
- **AND** la spiegazione resta quella che il reaper mette in `content`, che è ciò che quella riga disegna

#### Scenario: Riprova rimanda l'ultimo messaggio dell'utente
- **GIVEN** il banner di turno interrotto a schermo
- **WHEN** si preme «Riprova»
- **THEN** l'ultimo messaggio dell'utente riparte come turno nuovo

#### Scenario: Il banner sparisce quando la risposta arriva
- **GIVEN** il banner di turno interrotto a schermo
- **WHEN** un turno nuovo risponde sulla stessa chat
- **THEN** il banner non c'è più

#### Scenario: Uno stop della persona non accende il banner
- **GIVEN** un turno chiuso con causa `user`
- **THEN** il banner «Risposta interrotta» non compare

### Requirement: CHAT-INT-02 — Una ripresa automatica si vede mentre accade

Quando il server riprende da solo un turno che il suo riavvio aveva tagliato
(rimandando l'ultimo messaggio dell'utente), il turno SHALL dichiararlo sul filo
(`resumedBy: "server"` su `stream:start`) e il banner SHALL dire che la ripresa
è in corso, con lo stesso indicatore di attività di una risposta in streaming.

Il comando «Riprova» NON SHALL essere disponibile mentre la ripresa è in corso:
rimanderebbe lo stesso messaggio che il server sta già rimandando, cioè un
secondo turno su una chat che ne ha uno aperto. Il banner SHALL chiudersi da sé
al primo token, e SHALL tornare allo stato «Risposta interrotta» con la causa e
il comando di rimando se la ripresa finisce a sua volta con una causa.

Il banner SHALL stare in fondo al thread, sotto l'ultimo messaggio e sopra il
composer, dove l'occhio sta durante una risposta.

#### Scenario: Il server riprende e il banner lo dice
- **GIVEN** un turno tagliato con causa `server-shutdown` e il banner a schermo
- **WHEN** il server riprende da solo sulla stessa chat
- **THEN** il banner dice che la ripresa è in corso, con l'indicatore di attività
- **AND** il comando «Riprova» non è più a schermo

#### Scenario: Il primo token chiude il banner
- **GIVEN** il banner di ripresa in corso a schermo
- **WHEN** arriva il primo token della risposta ripresa
- **THEN** il banner non c'è più

#### Scenario: Una ripresa che fallisce riporta la via d'uscita
- **GIVEN** il banner di ripresa in corso a schermo
- **WHEN** anche il turno ripreso finisce con una causa di interruzione
- **THEN** il banner torna «Risposta interrotta» con quella causa
- **AND** il comando «Riprova» è di nuovo a schermo

### Requirement: USERROW-01 — A `user` row nobody typed says so, and one somebody typed does not

Two turns reach the chat wearing the person's role without being the person:
the dispatcher's envelope (kickoff, resume, nudge of a board task) and the goal
loop continuation. Both HAVE to be `user` rows, because that is the only role a
provider answers. Measured on the live database: 411 rows opening with the
kickoff text and 1,033 with the interrupted-turn text, all with a NULL author.

A row written by the dispatcher SHALL carry a `dispatched-envelope` mark, and a
row bought by the goal loop SHALL carry a `goal-nudge` mark with its attempt
number. A row the person really typed SHALL carry NOTHING: absent marks are
what gives the present ones any meaning.

The absence SHALL be `undefined`, never an empty list: an empty `blocks` column
would claim "we looked and found nothing" where the truth is there was nothing
to mark, and it is also what every row written before this rule carries.

A continuation number that is not a positive number NOT SHALL produce a mark:
zero is the loop saying it bought nothing, and a non-numeric value is not a
continuation to invent one from.

#### Scenario: the person's own message
- **GIVEN** a `user` row with no dispatch and no continuation
- **THEN** no marks SHALL be written, and the column SHALL stay unset

#### Scenario: the board's envelope
- **GIVEN** a turn the board drives
- **THEN** the row SHALL carry the `dispatched-envelope` mark

#### Scenario: a continuation the loop bought
- **GIVEN** a turn bought by the goal loop as attempt 3
- **THEN** the row SHALL carry the continuation mark with attempt 3

### Requirement: DISPENV-01 — The dispatcher's envelope is drawn as a service line, not as your bubble

A row marked as the dispatcher's envelope NOT SHALL be drawn as a right-hand
user bubble: three hundred lines of generated instructions in the person's
mouth, with an "edit" button on hover, is the transcript lying about who spoke.

The renderer SHALL read the mark off the row's blocks and draw ONE collapsed
service line instead. COLLAPSED, NOT HIDDEN: the resume envelope quotes the
person's own message inside it, so the text SHALL stay one click away.

The mark SHALL be recognised beside other marks on the same row, and an
unmarked row SHALL keep the ordinary bubble.

#### Scenario: a kickoff row
- **GIVEN** a `user` row carrying the `dispatched-envelope` mark
- **THEN** the service line SHALL be rendered and the user bubble NOT SHALL be

#### Scenario: a row a person typed
- **GIVEN** a `user` row with no marks
- **THEN** the ordinary bubble SHALL be rendered

### Requirement: CHAT-ENV-01 — La busta dispatchata porta i commenti che consegna, e le buste già scritte si marcano

Una riga `user` scritta dal dispatcher (kickoff, ripresa, sollecito, continuazione
dopo un'interruzione) SHALL portare il blocco `{ kind: 'dispatched-envelope' }`, e
una busta di ripresa SHALL poter portare `commentIds: string[]`, gli id dei
commenti umani che consegna. Il blocco SHALL essere scritto ALLA FONTE da chi
avvia il turno (`dispatchedFor` nel body di `/api/chat`), e NON SHALL essere
dedotto dal testo da nessun lettore: il client SHALL riconoscere una busta SOLO dal
blocco.

Le buste già scritte prima del marchio SHALL essere marcate da una migration che
riconosce le quattro aperture del dispatcher ANCORATE all'inizio della riga, su
righe `role='user'` con `blocks IS NULL`; una riga già marcata SHALL restare
com'è, e una riga di una persona che cita la busta a metà frase SHALL restare
`NULL`. La migration SHALL essere provata ESEGUENDO il file su un DB sintetico, e
il DB vivo SHALL essere salvato PRIMA che il file esista.

Una busta marcata SHALL essere disegnata dalla chat del topic come riga collassata
(`DispatchEnvelopeRow`), la stessa che usa la conversazione della card.

MISURA: `sqlite3 -readonly data/topics.db "select count(*) from messages where
role='user' and blocks is null and (content like 'You are the exclusive owner of
task%' or content like 'Human update on task%' or content like 'Your previous turn
on this task was interrupted%' or content like 'LAST TURN on%')"` → 0 (riferimento
prima della migration: 2301). `bun test tests/integration/migration-*-dispatched-envelopes.test.ts`
verde: quattro aperture marcate, la riga umana a metà frase `NULL`, la riga già
marcata invariata. `bun test server/lib/user-row-marks.test.ts` verde:
`commentIds` scritti solo con `dispatched` e con elenco non vuoto.

#### Scenario: la ripresa porta gli id
- **GIVEN** un turno avviato con `dispatched: true` e `dispatchedFor: ['c1']`
- **THEN** la riga `user` salvata ha `blocks = [{kind:'dispatched-envelope', commentIds:['c1']}]`

#### Scenario: il kickoff non porta id
- **GIVEN** un turno avviato con `dispatched: true` senza `dispatchedFor`
- **THEN** la riga ha `blocks = [{kind:'dispatched-envelope'}]`

#### Scenario: le buste vecchie si marcano, la citazione no
- **GIVEN** un DB sintetico con quattro righe `user` che aprono con le quattro buste,
  una riga `user` «come diceva: Human update on task…» e una riga già marcata
- **WHEN** il file di migration viene eseguito
- **THEN** le quattro righe hanno il blocco `dispatched-envelope`
- **AND** la riga che cita resta con `blocks IS NULL`
- **AND** la riga già marcata è identica a prima

#### Scenario: la chat non attribuisce la busta alla persona
- **GIVEN** una riga `user` marcata `dispatched-envelope`
- **THEN** la chat del topic la disegna come riga collassata, non come bolla della persona

### Requirement: CHAT-FAIL-01 — Un'azione della chat che fallisce lo DICE

Quattro azioni del pannello di chat scrivono sul server senza aggiornamento
ottimistico: «Remember this» sulla bolla, la barra dell'obiettivo (chiusura e
rinomina), le pastiglie del contesto (esclusione e rimozione file) e l'incolla di
immagini nel composer. Per ognuna, un rifiuto del server SHALL produrre un toast
di errore che riporta il messaggio del server, e NON SHALL essere buttato in un
`catch {}` vuoto o in un `console.warn`.

Sulla RINOMINA dell'obiettivo il campo di modifica SHALL restare aperto col testo
digitato finché la scrittura non riesce: chiuderlo prima della risposta rimette a
schermo il testo vecchio, che è indistinguibile da un successo. Un secondo invio
mentre la prima scrittura è in volo NON SHALL partire.

L'incolla di più immagini SHALL usare `Promise.allSettled`: le immagini leggibili
entrano nel composer e il toast SHALL nominare il file scartato. Una sola immagine
illeggibile NON SHALL far cadere l'intero incollaggio.

FUORI: nessun aggiornamento ottimistico nuovo. La barra continua a mostrare quello
che il server ha davvero.

MISURA: `npx playwright test tests/e2e/chat-silent-failures.spec.ts` verde, quattro
scenari, ciascuno con la sua rotta mockata a 500 o abortita.

#### Scenario: «Remember this» rifiutato lo dice
- **GIVEN** una bolla dell'assistente con il bottone «Remember this»
- **AND** `POST /api/memory/*/append` risponde 500
- **WHEN** la persona clicca il bottone
- **THEN** compare un toast di errore con il messaggio del server

#### Scenario: la rinomina dell'obiettivo che fallisce tiene il campo aperto
- **GIVEN** una barra dell'obiettivo con un obiettivo attivo
- **AND** la scrittura del goal risponde 500
- **WHEN** la persona apre la matita, scrive un testo nuovo e conferma
- **THEN** compare un toast di errore
- **AND** il campo di modifica resta aperto col testo digitato, non col vecchio

#### Scenario: la pastiglia di contesto che non si spegne lo dice
- **GIVEN** il popover del contesto con un file elencato
- **AND** `PATCH /api/topics/*` risponde 500
- **WHEN** la persona spegne la pastiglia
- **THEN** compare un toast di errore
- **AND** la pastiglia resta accesa, perché il file è ancora nel contesto

#### Scenario: un'immagine illeggibile non porta via le altre
- **GIVEN** il composer a fuoco
- **WHEN** la persona incolla insieme un'immagine valida e una corrotta
- **THEN** l'anteprima della valida entra nel composer
- **AND** un toast di errore nomina il file scartato

### Requirement: CHAT-HIST-01 — La chat si apre sulla CODA, e il resto arriva quando nessuno guarda

All'apertura di una chat — ricarico, cambio scheda, rientro — il client SHALL
chiedere al server SOLO gli ultimi `HISTORY_FIRST_PAGE` messaggi
(`shared/history-paging.ts`), e il sipario SHALL alzarsi quando QUELLA pagina è
dipinta, intera e ferma. Prima aspettava la storia completa, che su una chat
vera pesa da 200 KB a 2,6 MB e arriva in 0,7-1,7 s, cioè fino al tetto del
sipario (1200 ms). Una chat con meno di una pagina di messaggi SHALL fare UNA
richiesta sola, come prima; la coda NON SHALL essere chiesta due volte.

La copia locale (`messages-cache-*`) SHALL contenere la STESSA coda della prima
pagina, per numero di messaggi, con il tetto in byte come sola guardia: così il
primo fotogramma disegnato dalla cache È la prima pagina, e la risposta del
server la conferma senza aggiungere né togliere righe.

I messaggi precedenti (`limit: 0` con il cursore `before` = id del più vecchio
della pagina, WIRE-11) SHALL essere caricati e fusi nello store SOLO quando la
pane non è a schermo (scheda dietro un'altra, viewport alta zero), oppure su
richiesta: MAI sotto gli occhi di chi legge. Una lista virtuale indirizza le
righe per indice, e anteporre ottanta messaggi cambia ciò che «la riga 30»
mostra; il rimedio che Virtuoso offre (`firstItemIndex`) è stato misurato a CLS
0,60 su un gesto il cui contratto è 0,01 (PERF-01). Al ritorno della pane la
viewport SHALL trovarsi dove era: in fondo se lì riposava, sulla riga che aveva
in cima se la persona aveva scorso. Nessuno scheletro nuovo, nessuno scorrimento
automatico all'arrivo in cima (`startReached`).

Finché il resto non è arrivato la chat è PARZIALE, e in cima alla finestra
caricata SHALL comparire una riga discreta «Carica i messaggi precedenti (n)» —
stessa geometria dei divisori di compattazione, icona lucide, italiano e inglese
— che al click carica il resto e riàncora la lista sul messaggio che era il
primo: un salto chiesto non è uno spostamento. Le superfici che leggono «tutti i
messaggi» SHALL saperlo (`historyCompleteness`): un divisore di compattazione la
cui ancora non è ancora caricata NON SHALL essere disegnato in cima; un salto
dalla palette a un messaggio non ancora presente SHALL chiedere il resto invece
di rinunciare al bersaglio. I percorsi che ricevono il thread intero (cambio
ramo, cancellazione, ricarico dopo una modifica) SHALL marcare la chat completa.

#### Scenario: il sipario si alza sulla coda, e la pagina vecchia non viene nemmeno chiesta finché la pane è a schermo
- **GIVEN** una chat con tre pagine di messaggi già vista da questo dispositivo
- **AND** la risposta ai messaggi precedenti alla prima pagina trattenuta per due secondi
- **WHEN** la persona ricarica e resta a guardare la chat
- **THEN** la conversazione è visibile con i suoi ultimi messaggi entro il tetto del sipario
- **AND** la coda è stata chiesta una volta sola e i messaggi precedenti zero volte
- **AND** il CLS del ritorno resta al più 0,01

#### Scenario: la storia si completa mentre la scheda è dietro un'altra
- **GIVEN** la chat parziale del primo scenario
- **WHEN** la persona passa a un'altra scheda e poi torna
- **THEN** i messaggi precedenti sono stati chiesti (una volta) mentre la scheda era nascosta
- **AND** al ritorno la chat è di nuovo in fondo, sull'ultimo messaggio
- **AND** il primo messaggio della chat è raggiungibile scorrendo in alto, senza la riga «Carica i messaggi precedenti»

#### Scenario: chi scorre in alto prima del completamento trova la riga, e il click lo porta al primo messaggio
- **GIVEN** la chat parziale appena ricaricata
- **WHEN** la persona scorre subito in cima alla finestra caricata
- **THEN** compare la riga «Carica i messaggi precedenti (n)» con n = messaggi mancanti
- **WHEN** la clicca
- **THEN** la lista si riàncora sul messaggio che era il primo
- **AND** scorrendo ancora in alto il primo messaggio della chat è visibile

#### Scenario: una chat più corta di una pagina
- **GIVEN** una chat con meno di `HISTORY_FIRST_PAGE` messaggi
- **WHEN** la persona ricarica
- **THEN** il client fa UNA sola richiesta di storia, nessuna con `before`

### Requirement: CHAT-WAIT-03 — ⌘J porta alla prossima chat che ti aspetta

Un comando SHALL portare il fuoco sulla prossima riga della sidebar in attesa di
una tua risposta, nel senso di CHAT-WAIT-01: ferma su una domanda o un
permesso, oppure su un piano da approvare quando a chiederlo è Claude Code con
gli hook (`cli` e terminali Claude Code). Da tastiera è `Mod+J` (⌘J sul Mac,
Ctrl+J altrove).

**Le mete.** Una meta SHALL essere una riga chat il cui topic sta in
`awaitingInputTopics`, oppure una riga terminale Claude Code il cui id sta in
`claudePhaseAwaitingInputTermIds`: le righe che la sidebar colora d'ambra. Una
chat al lavoro, una chat col turno finito (`awaiting-user`, `paused`) e un
sotto-agente annidato NON SHALL essere mete. Nemmeno la chat del runtime
nativo col piano che l'app chiede a fine turno (`server/lib/plan-approval.ts`):
il turno è chiuso, la riga non è ambra, e questa change non la colora. Il
«visto» non conta: una meta guardata resta una meta finché la domanda è aperta.

**L'ordine.** Le mete SHALL essere ordinate da una funzione pura
`waitingQueue(allItems, pinnedIds, sig)` in `client/src/lib/waitingQueue.ts`:
prima le righe fissate, nell'ordine dei Fissati (un progetto fissato porta al
suo posto le mete fra le sue tab, che la sua fascia disegna lì e la lista sotto
non ripete); poi quelle che `groupSidebarItemsByState` mette in «Attende te», nel
loro ordine. Ogni soggetto
SHALL comparire una volta sola, alla prima occorrenza: una chat fissata dentro un
progetto sta sia fra i Fissati sia fra i figli che la vista promuove, e conta
fra i Fissati.

**Il passo.** La meta SHALL essere scelta da una funzione pura
`nextWaiting(queue, focused, last)`:

- se la riga a fuoco è una meta, la prima meta dopo di lei; dopo l'ultima, la
  prima;
- se la riga a fuoco è quella dove l'ultimo passo ti ha portato e non è più una
  meta, la prima meta che la seguiva nella coda di quel passo; se non ne resta
  nessuna, la prima;
- altrimenti la prima meta.

Nessuna meta diversa dalla riga a fuoco SHALL dare un avviso («Nessuna chat ti
aspetta» a coda vuota, «Nessun'altra chat ti aspetta» se l'unica è quella a
fuoco) e nessun cambio di fuoco.

**Il gesto.** Il tasto SHALL annunciare l'evento `topics:next-waiting` e basta;
la sidebar (`TopicTree`) SHALL rispondere chiamando lo stesso gestore del clic
sulla riga: `handleChatRowClick` per le chat, e per i terminali un
`handleTerminalRowClick` che spegne il «finito» (`clearTerminalFinished`) e poi
chiama `onTerminalClick`, estratto dalla riga (`TopicTree.tsx:2376`) e usato da
lei e dal tasto. Una meta disegnata nella card di un gruppo che la finestra non
mostra SHALL passare prima da `goToSpace` di quel gruppo, come fa la cattura del
clic sulla card (`SpaceGroups`): la finestra va sul gruppo, e in una
finestra-gruppo (`?space=`) la query lo segue; un gruppo che vive in una
finestra sua viene portato davanti. Una meta FISSATA non sta in nessuna card
(i fissati stanno nel blocco delle tessere sopra i gruppi): il suo gruppo SHALL
leggersi dalla mappa delle pane (`sidebarItemSpace`), e la meta SHALL fare la
stessa deviazione; anche il clic sulla sua tessera la fa, e così SHALL fare la
tessera di OGNI tipo (chat, terminale, progetto, browser, utility), dalla stessa
`goToHomeSpaceOf`. Fa eccezione la sola board, che porta la finestra dal suo
gruppo con `onOpenBoard`. In una finestra normale (senza `?space=`) il passo
SHALL commutare la griglia sul gruppo della meta, e la query NON SHALL comparire.

**Il tasto.**

- Il registro `shared/shortcuts.ts` SHALL avere la voce `[MOD, 'J']` nel gruppo
  «Chat» con `native: { chars: ['j'] }`, e `shortcuts_generated.rs` SHALL essere
  rigenerato: con una pane browser a fuoco l'accordo SHALL arrivare lo stesso.
- Il gestore SHALL confrontare `e.key`, non `e.code`, e SHALL scattare anche con
  il fuoco nel composer o in un altro campo di testo.
- Sul ramo `ctrlKey` il gestore SHALL cedere a terminale ed editor
  (`isRawKeySurfaceFocused`), dove Ctrl+J è un tasto vero.
- Con Shift o Alt premuti il gestore NON SHALL scattare.

#### Scenario: due chat in attesa e una al lavoro
- **GIVEN** su `:13334`, vista per stato, tre chat: A ferma su un permesso (`session:state` con fase `awaiting-approval`), B ferma su una domanda dentro l'app (stream aperto e ultima riga con `mcp__topics__ask_user_question` in `waiting_for_input`), C con uno stream aperto e nessuna domanda
- **AND** il fuoco su C
- **WHEN** si preme ⌘J tre volte
- **THEN** la tab a fuoco (`[role="tab"][data-active="true"]`) è, nell'ordine, la prima riga di `sidebar-state-section-awaiting`, poi la seconda, poi di nuovo la prima
- **AND** C non riceve mai il fuoco

#### Scenario: la successiva dopo quella a fuoco
- **GIVEN** `queue = [A, B, C]` e il fuoco su B
- **WHEN** si chiede `nextWaiting`
- **THEN** la risposta è C

#### Scenario: dopo l'ultima si riparte
- **GIVEN** `queue = [A, B, C]` e il fuoco su C
- **THEN** la risposta è A

#### Scenario: il fuoco fuori dalla coda
- **GIVEN** `queue = [A, B]`, il fuoco su una chat al lavoro e nessun passo precedente
- **THEN** la risposta è A

#### Scenario: dopo una risposta si va avanti, non indietro
- **GIVEN** l'ultimo passo ha portato su B con `queue = [A, B, C]`
- **AND** hai risposto a B, quindi ora `queue = [A, C]` e il fuoco è ancora su B
- **THEN** la risposta è C

#### Scenario: nessun'altra meta
- **GIVEN** `queue = [A]` e il fuoco su A, oppure `queue = []`
- **THEN** la risposta è `null`

#### Scenario: in app, nessun'altra chat ti aspetta
- **GIVEN** su `:13334` una sola chat A ferma su un permesso (`session:state` con fase `awaiting-approval`), a fuoco
- **WHEN** si preme ⌘J
- **THEN** compare il `toast` «Nessun'altra chat ti aspetta»
- **AND** la tab a fuoco è ancora A

#### Scenario: l'ordine è quello della sidebar
- **GIVEN** una chat fissata F in attesa, una chat P in attesa dentro un progetto, e una chat L in attesa fuori dai progetti che nella lista sta sopra al progetto
- **WHEN** si calcola `waitingQueue`
- **THEN** la coda è `[F, L, P]`

#### Scenario: una chat fissata dentro un progetto conta una volta
- **GIVEN** una chat X fissata e in attesa dentro un progetto, e una chat A in attesa fuori dai progetti
- **WHEN** si calcola `waitingQueue`
- **THEN** la coda è `[X, A]`, e la sua lunghezza, che è il numero della porta di CHAT-WAIT-04, è 2

#### Scenario: una chat in attesa dentro un progetto fissato
- **GIVEN** un progetto fissato con dentro una chat Q in attesa, e una chat A in attesa fuori dai progetti
- **WHEN** si calcola `waitingQueue`
- **THEN** la coda è `[Q, A]`

#### Scenario: un turno finito non è una meta
- **GIVEN** una chat in `awaitingFeedbackTopics` per la fase `awaiting-user` e non in `awaitingInputTopics`
- **THEN** non è nella coda

#### Scenario: un terminale fermo su un permesso è una meta
- **GIVEN** un terminale Claude Code in `claudePhaseAwaitingInputTermIds`
- **THEN** è nella coda, al posto della sua riga

#### Scenario: su Windows Ctrl+J resta al terminale
- **GIVEN** su `:13334` una chat A ferma su un permesso e il fuoco dentro un terminale
- **WHEN** si scrive `echo $((6*7))<marcatore>` e si preme Ctrl+J (`ctrlKey` sì, `metaKey` no)
- **THEN** il terminale stampa `42<marcatore>`: il tasto è arrivato alla shell come a capo
- **AND** A non riceve il fuoco
- **WHEN** si preme ⌘J nello stesso terminale
- **THEN** a fuoco va A

#### Scenario: su Windows Ctrl+J resta all'editor
- **GIVEN** su `:13334` una chat A ferma su un permesso e il fuoco dentro un editor CodeMirror (`.cm-editor`) di un progetto
- **WHEN** si preme Ctrl+J e poi si scrive un marcatore
- **THEN** il marcatore compare nell'editor e A non riceve il fuoco
- **WHEN** si preme ⌘J nello stesso editor
- **THEN** a fuoco va A

#### Scenario: Ctrl+J scatta anche dal composer
- **GIVEN** su `:13334` una chat A ferma su un permesso e il fuoco nel composer di un'altra chat
- **WHEN** si preme Ctrl+J
- **THEN** a fuoco va A

#### Scenario: in una finestra-gruppo ⌘J va dove va il clic sulla riga
- **GIVEN** su `:13334` una finestra `?space=<G>` con A nel gruppo G e B nel gruppo Principale, entrambe ferme su un permesso, e il fuoco su A
- **WHEN** si preme ⌘J
- **THEN** la tab a fuoco è B, il gruppo attivo è Principale e la query dice `space=space:default`
- **WHEN** si preme ⌘J di nuovo
- **THEN** la tab a fuoco è A e il gruppo attivo è di nuovo G

#### Scenario: una meta fissata con la tab in un altro gruppo
- **GIVEN** la stessa finestra `?space=<G>`, con B fissata e la sua tab nel gruppo Principale
- **WHEN** si preme ⌘J
- **THEN** la tab a fuoco è B e il gruppo attivo è Principale
- **WHEN** dopo essere tornati su A si clicca la tessera di B
- **THEN** la tab a fuoco è di nuovo B, nel gruppo Principale

#### Scenario: una tessera progetto o browser con la tab in un altro gruppo
- **GIVEN** la finestra `?space=<G>`, con un progetto e un browser fissati e le loro tab nel gruppo Principale
- **WHEN** si clicca la tessera del progetto
- **THEN** il gruppo attivo è Principale e la tab del progetto è attiva
- **WHEN** di nuovo in `?space=<G>` si clicca la tessera del browser
- **THEN** il gruppo attivo è Principale e la tab del browser è attiva

#### Scenario: nella finestra normale ⌘J commuta la griglia sul gruppo della meta
- **GIVEN** su `:13334` una finestra senza `?space=`, con A nel gruppo G e B nel gruppo Principale, entrambe ferme su un permesso, la finestra su Principale e il fuoco su B
- **WHEN** si preme ⌘J
- **THEN** la tab a fuoco è A, il gruppo attivo è G e la URL non ha `space`
- **WHEN** si preme ⌘J di nuovo
- **THEN** la tab a fuoco è B e il gruppo attivo è di nuovo Principale

#### Scenario: l'accordo passa anche da una pane browser
- **WHEN** la tabella decisionale dei tasti riceve Ctrl+J (`chords.rs`)
- **THEN** l'accordo è inoltrato alla webview principale come `key:'j'`

### Requirement: CHAT-WAIT-04 — Sul telefono la stessa coda è una porta in fondo

La fila in fondo al telefono (`MobileChromeBar`) SHALL avere una porta «In
attesa», prima del Profilo, con il glifo `Hourglass` della sezione «Attende te».

- Il numero sulla porta SHALL essere la lunghezza della coda di CHAT-WAIT-03,
  letta dallo stesso store: numero e mete non possono divergere, e una chat
  fissata dentro un progetto conta una volta.
- Premerla SHALL fare lo stesso passo di ⌘J (evento `topics:next-waiting`).
- A coda vuota la porta SHALL restare al suo posto, `disabled`, con un titolo
  che dice che nessuna chat ti aspetta: le altre porte NON SHALL spostarsi quando
  il numero cambia.
- Il nome accessibile della porta SHALL portare il numero, zero compreso
  («In attesa, 3», «In attesa, 0»): il numero sulla porta è solo disegnato, e il
  titolo resta il suggerimento.
- Il Profilo SHALL restare l'ultima porta; ogni porta SHALL restare almeno 44 px
  e la fila SHALL continuare a seguire la curva dello schermo agli estremi.

#### Scenario: la porta porta alle due in attesa
- **GIVEN** su `:13334` un viewport da telefono e le tre chat di CHAT-WAIT-03
- **THEN** `mobile-chrome-waiting` mostra `2`
- **AND** il suo nome accessibile è «In attesa, 2»
- **WHEN** la si preme due volte
- **THEN** a fuoco va la prima meta e poi la seconda, e mai la chat al lavoro

#### Scenario: a zero è spenta e non sposta niente
- **GIVEN** nessuna chat in attesa
- **THEN** `mobile-chrome-waiting` è `disabled`, e il suo nome accessibile è «In attesa, 0»
- **AND** le cinque porte hanno la stessa larghezza di quando il numero è `2`

### Requirement: CHAT-FORK-01 — Diramare crea una chat NUOVA con la stessa storia, e l'originale non cambia

`POST /api/topics/:id/fork` (`server/routes/fork.ts`, nuovo) SHALL creare, in
UNA transazione:

- un topic nuovo, con un `sessionKey` suo, che eredita dall'originale
  `provider`, `model`, `effort`, `autonomyLevel`, `fastMode`, `topicsRouting`,
  `projectPath`, `worktreeId`, `systemPrompt`, `contextFiles`,
  `disabledContextSources`, `color` e `icon`. NON SHALL ereditare
  `pinnedMessages`, `mcpPolicy`, `muted`, `browserState`, `initialMessage` né
  l'obiettivo. Il nome è `name` del corpo, o `«<nome> (ramo)»` se manca;
- la copia del RAMO ATTIVO dell'originale (`loadActiveThread(sk, { withBlocks: true })`,
  `server/utils.ts:1300`) dalla radice al punto del ramo compreso, con id nuovi,
  `parentId` rimappati sulla riga copiata precedente e `branchIndex` 0, e per
  ogni riga contenuto, blocchi, strumenti, allegati, pensiero, autore, orari,
  modello e latenza. Le righe `partial` NON SHALL essere copiate. Il consumo
  (`costCents`, i token di prompt e di risposta, i tre token di cache) NON
  SHALL essere copiato: per le copie nessuno ha chiamato un modello, e ogni
  cifra di spesa (dashboard, profilo, consumo per progetto e per persona)
  somma `messages` su tutte le sessioni, quindi copiato conterebbe due volte;
- una riga in `chat_forks` con la madre, il suo nome, l'ultima riga copiata e
  il modo del runtime (CHAT-FORK-03).

Il punto del ramo SHALL essere l'ultima risposta `assistant` finita del ramo
attivo che non porti il marchio della macchina (`hasMachineMark`,
`shared/prompt-number.ts:18`): un avviso di background o una riga di stop sono
righe `assistant` scritte da Topics, non risposte, e non SHALL essere il punto.

Un `/clear` sul ramo SHALL azzerare `parent_ref` e `parent_at` della sua riga in
`chat_forks`: una chat svuotata non riprende la storia di nessuno.

Le righe dell'originale NON SHALL cambiare: né i messaggi, né
`active_branches`, né la riga della sua sessione presso il fornitore.

La rotta SHALL rifiutare, PRIMA di scrivere qualunque cosa:

- topic inesistente: 404;
- coordinatore globale (`isGlobalOrchestratorSession`): 403
  `orchestrator_topic_invariant`, come `server/routes/edit.ts:248-253`;
- turno in corso sull'originale (`isStreaming`): 409 `turn_in_progress`;
- runtime senza strada (CHAT-FORK-03 dice `null`): 409 `fork_unsupported`;
- nessuna risposta finita nel ramo attivo: 400 `nothing_to_fork`.

Riuscita: 201 col topic proiettato (con `forkedFrom`, CHAT-FORK-05) e il
broadcast `topic:created`.

Dove cambiarla: scelta 1 (il punto del ramo), scelta 3 (`projectPath` e
`worktreeId`: con il «no» il ramo riceve una worktree nuova dal ramo git della
madre), scelta 4 (il 409 `turn_in_progress`).

#### Scenario: stessa storia, e l'originale resta com'era
- **GIVEN** un topic con 3 turni (6 righe) nel ramo attivo e una risposta alternativa non attiva sotto il secondo prompt
- **WHEN** si chiama `POST /api/topics/:id/fork`
- **THEN** la risposta è 201 e `GET /api/history/<sessionKey del ramo>` dà 6 righe con gli stessi ruoli e contenuti, nello stesso ordine, e nessun id in comune con l'originale
- **AND** `GET /api/history/<sessionKey dell'originale>` dà le stesse righe, con gli stessi id, di prima della chiamata

#### Scenario: il ramo eredita come lavora, non cosa ricorda la pagina
- **GIVEN** un topic con modello, effort, autonomia, progetto e worktree scelti, un messaggio fissato e `mcpPolicy` `bridge-only`
- **WHEN** lo si dirama
- **THEN** il topic nuovo ha lo stesso modello, effort, autonomia, `projectPath` e `worktreeId`
- **AND** ha `pinnedMessages` vuoto e `mcpPolicy` nullo

#### Scenario: la copia non spende
- **GIVEN** un topic la cui risposta ha costato 500 centesimi, con 100.000 token di prompt e 40.000 di cache
- **WHEN** lo si dirama
- **THEN** il costo misurato e i token del profilo (`computeProfileStats`) e i totali per progetto (`projectUsage`) sono gli stessi di prima
- **AND** la copia della risposta ha lo stesso modello e la stessa latenza, e nessun costo né token

#### Scenario: una riga a metà non si copia
- **GIVEN** un ramo attivo che finisce con una risposta finita seguita da una riga `partial` rimasta da uno stream perso
- **WHEN** lo si dirama
- **THEN** la copia finisce alla risposta finita, e la riga `partial` non c'è

#### Scenario: un avviso di background in coda non è il punto
- **GIVEN** un ramo attivo che finisce con una risposta finita seguita da un avviso di background (riga `assistant` con un blocco `background-notice`)
- **WHEN** lo si dirama
- **THEN** la copia finisce alla risposta, l'avviso non c'è, e `forkedFrom.atMessageId` è la copia della risposta

#### Scenario: durante un turno non si dirama
- **GIVEN** un topic con un turno in corso
- **WHEN** si chiama la rotta
- **THEN** la risposta è 409 con `code: "turn_in_progress"`
- **AND** il numero di topic e le righe dell'originale non cambiano

#### Scenario: il coordinatore non si dirama
- **GIVEN** la chat del coordinatore globale
- **WHEN** si chiama la rotta
- **THEN** la risposta è 403 con `code: "orchestrator_topic_invariant"`

### Requirement: CHAT-FORK-02 — La sessione Claude Code del ramo nasce da quella della madre, fissata al punto del ramo

Per un ramo con runtime `claude-cli`, alla creazione la rotta SHALL leggere
l'id di sessione della madre (`claude_code_sessions`) e il suo transcript,
dovunque la CLI l'abbia archiviato (`findClaudeTranscript`,
`server/lib/claude-transcript-path.ts`: prima sotto la cwd attuale della
madre, poi in ogni cartella di `~/.claude/projects`; una madre spostata di
progetto dopo i suoi turni ha il transcript sotto la cwd di prima, e la CLI la
riprende lo stesso), prendere
come `parent_at` l'`uuid` dell'ultima riga `type: "assistant"` non
`isSidechain`, coniare l'uuid del ramo e scriverlo in
`claude_code_sessions(sessionKey del ramo, uuid del ramo)` con `import_offset`
nullo e in `chat_forks.branch_ref`.

`parent_ref` SHALL restare nullo, e la rotta NON SHALL scrivere né la riga in
`claude_code_sessions` né `branch_ref`, quando:

- la madre non ha sessione, o il transcript non c'è, o non contiene una
  risposta;
- una riga del ramo attivo, dalla radice al punto, ha `branch_index > 0`
  (Modifica o Rigenera: risposte stateless, `server/routes/edit.ts:131-135`,
  che la sessione della CLI non ha mai visto);
- dopo il punto il ramo attivo ha altre righe oltre agli avvisi di background
  (una riga `partial`, un prompt senza risposta, una riga di stop);
- il testo del punto, spazi ai bordi e righe `MEDIA:` in coda esclusi, non
  finisce col testo dell'ultima riga `assistant` del transcript (anch'esso senza
  le righe `MEDIA:` in coda), o quella riga non ha testo.

In quei casi il ramo parte fresco: lo spawn conia la sessione con `isNew` vero e
il suo primo messaggio porta il riepilogo del database (CCLI-06), cioè la storia
copiata. Il modello del ramo non SHALL conoscere turni che la chat del ramo non
mostra.

Allo spawn (`server/providers/claude-code.ts:2427-2512`), con `parent_ref`
presente, la sessione del ramo UGUALE a `branch_ref` e il transcript DEL RAMO
assente, l'argv SHALL finire con
`--resume <madre> --resume-session-at <parent_at> --fork-session --session-id <ramo>`
(`buildClaudeArgs`, `server/providers/claude/args.ts:374`), SENZA il prologo
di riepilogo (`needsHistoryReplay` falso, `claude-code.ts:2570`): la memoria
arriva dalla CLI, e il riepilogo la duplicherebbe. Con il transcript del ramo
presente l'argv SHALL finire con `--resume <ramo>` e SENZA `--fork-session`:
rifare il fork su un id che esiste è un errore della CLI (misurato il 28/09,
«Session ID … is already in use.», exit 1).

Il fork SHALL avvenire al più una volta. Il primo `system/init` dello spawn
col fork SHALL consumarlo: `parent_ref` e `parent_at` diventano nulli, come al
`thread.started` di un turno `fork` di Codex (CODEX-02). Il controllo sul
transcript del ramo guarda solo la cwd attuale, e la cwd di una chat cambia
(`/project open`, `open_project`, l'autoBind, un PATCH di `projectPath`):
senza il consumo un ramo spostato di progetto rifaceva il fork dalla madre, e
il modello perdeva i turni del ramo senza riepilogo (misurato su CLI 2.1.284,
secondo giro delle verifiche). Una sessione del ramo dimenticata
(`/clear`, il reap della worktree, il recupero da sessione persa) SHALL farlo
ripartire con un uuid diverso da `branch_ref`, quindi con `--session-id` e il
riepilogo di ciò che il database ha in quel momento, MAI con `--fork-session`:
rifatto, il fork riporterebbe la storia della madre in una chat svuotata, o
toglierebbe al modello i turni del ramo (misurato su CLI 2.1.284: il fork
rifatto con lo stesso id da un'altra cwd esce 0).

Se l'avvio del ramo è rifiutato perché la sessione madre non c'è più (i motivi
di `SESSION_NOT_FOUND_PATTERNS`, `claude-code.ts:616`), perché il punto non c'è
nel suo transcript («No message found with message.uuid of: <uuid>», exit 1,
misurato su CLI 2.1.284) o perché la CLI non conosce `--fork-session` o
`--resume-session-at`, il recupero (`markMissingSessionRecovery`,
`claude-code.ts:3318`) SHALL dimenticare la sessione del ramo. Il turno SHALL
ripartire fresco col riepilogo, UNA volta, senza riprovare il fork.

Le due bandiere SHALL stare in `CRITICAL_CLAUDE_FLAGS`
(`server/providers/claude/cli-compat.ts:80`) e nello snapshot dell'argv
(CCLI-07).

#### Scenario: il primo avvio del ramo dirama
- **GIVEN** un ramo con `parent_ref` = P, `parent_at` = U, `branch_ref` = C, la sua sessione uguale a C, e nessun transcript per C
- **WHEN** si monta l'argv del suo spawn
- **THEN** l'argv contiene, in quest'ordine, `--resume P --resume-session-at U --fork-session --session-id C`
- **AND** il primo messaggio NON porta il prologo di riepilogo

#### Scenario: dal secondo avvio è una chat qualunque
- **GIVEN** lo stesso ramo, con il transcript di C ormai su disco
- **WHEN** si monta l'argv di un nuovo spawn
- **THEN** l'argv finisce con `--resume C`
- **AND** non contiene `--fork-session` né `--resume-session-at`

#### Scenario: un ramo spostato di progetto dopo il suo primo avvio riprende la sua sessione
- **GIVEN** un ramo il cui primo spawn col fork ha ricevuto `system/init`
- **WHEN** la chat passa a un altro progetto e si monta l'argv del suo spawn nella cwd nuova, dove il transcript del ramo non c'è
- **THEN** l'argv finisce con `--resume C` e non contiene `--fork-session`
- **AND** `parent_ref` del ramo è nullo

#### Scenario: una madre spostata di progetto dopo i suoi turni si dirama
- **GIVEN** una chat Claude Code il cui transcript sta sotto la cwd di prima, e il cui `projectPath` è ora un altro
- **WHEN** la si dirama
- **THEN** `parent_ref` è la sua sessione e `parent_at` l'uuid della sua ultima risposta

#### Scenario: la madre non aveva una sessione
- **GIVEN** un topic Claude Code con messaggi e nessuna riga in `claude_code_sessions` (per esempio una storia seminata)
- **WHEN** lo si dirama e si manda il primo messaggio nel ramo
- **THEN** prima del primo spawn il ramo non ha una riga in `claude_code_sessions`
- **AND** lo spawn del ramo usa `--session-id` senza `--fork-session`, al primo tentativo
- **AND** il primo messaggio porta il riepilogo della storia copiata

#### Scenario: con Rigenera attivo sulla madre il ramo parte dal riepilogo
- **GIVEN** una chat Claude Code con sessione e transcript, la cui ultima risposta visibile è stata rigenerata (riga con `branch_index` 1 nel ramo attivo)
- **WHEN** la si dirama
- **THEN** `parent_ref` del ramo è nullo e il ramo non ha una riga in `claude_code_sessions`
- **AND** lo spawn del ramo usa `--session-id` col riepilogo, senza `--fork-session`

#### Scenario: con un turno tagliato in coda il ramo parte dal riepilogo
- **GIVEN** una chat Claude Code il cui ramo attivo finisce con una risposta finita, un prompt e una riga `partial` rimasta da uno stream perso
- **WHEN** la si dirama
- **THEN** la copia finisce alla risposta finita e `parent_ref` del ramo è nullo

#### Scenario: la madre è sparita fra il clic e il primo messaggio
- **GIVEN** un ramo con `parent_ref` valorizzato e `branch_ref` = C, e il transcript della madre cancellato
- **WHEN** il primo spawn del ramo viene rifiutato con «No conversation found with session id»
- **THEN** la sessione del ramo viene dimenticata
- **AND** lo spawn successivo usa `--session-id` con un uuid diverso da C, col riepilogo, e non contiene `--fork-session`

#### Scenario: il punto non c'è più nel transcript della madre
- **GIVEN** un ramo con `parent_at` = U, e un transcript della madre che non contiene U
- **WHEN** il primo spawn del ramo viene rifiutato con «No message found with message.uuid of: U»
- **THEN** il rifiuto è letto come recupero, non come crash
- **AND** lo spawn successivo usa `--session-id` col riepilogo, e non contiene `--fork-session`

#### Scenario: `/clear` sul ramo non riporta la storia della madre
- **GIVEN** un ramo con `parent_ref` = P e `branch_ref` = C, con o senza turni suoi
- **WHEN** si fa `/clear` nel ramo e poi si manda un messaggio
- **THEN** lo spawn usa `--session-id` con un uuid diverso da C e non contiene `--fork-session` né `--resume P`
- **AND** il messaggio non porta né la storia della madre né un riepilogo

#### Scenario: la sessione del ramo persa dopo i suoi turni
- **GIVEN** un ramo che ha fatto 2 turni suoi, e la sua riga in `claude_code_sessions` cancellata (reap della worktree, `forgetBoundSessions`)
- **WHEN** si manda un messaggio nel ramo
- **THEN** lo spawn usa `--session-id` senza `--fork-session`
- **AND** il messaggio porta il riepilogo della storia copiata e dei 2 turni del ramo

#### Scenario: sul filo l'originale non cambia
- **GIVEN** una chat Claude Code vera con due turni, e lo `shasum` del suo transcript
- **WHEN** la si dirama e si fa un turno nel ramo
- **THEN** lo `shasum` del transcript della madre è lo stesso
- **AND** il ramo risponde su un fatto detto solo nella madre

### Requirement: CHAT-FORK-03 — Ogni runtime ha la sua strada, e chi non ce l'ha non offre la voce

Una funzione pura `forkModeFor(providerName)` in `shared/chat-fork.ts` SHALL
essere l'unica tabella, letta dal server e dal client:

- `claude-code` e `claude-code-team` → `claude-cli` (CHAT-FORK-02);
- `codex` → `codex-cli` (CODEX-02);
- `topics` (anche il vecchio `topics:<modello>`), `claude`, `openai` →
  `db-history`: rileggono la storia della propria sessione dal database a ogni
  turno (il nativo con `nativeHistorySource`,
  `server/providers/native/history-source.ts:22`, blocchi e strumenti
  compresi), quindi la storia copiata è la loro memoria e non serve altro;
- gli endpoint diretti, cioè ogni nome col prefisso `direct-`
  (`isDirectProviderName`, `shared/direct-endpoints.ts:83`) → `db-history`:
  `OpenAICompatibleProvider` ha la capacità `history` ed è `history-aware`
  come `openai` (`server/providers/openai-compatible.ts:79-81`);
- ogni altro nome, oggi `openclaw` e gli agenti ACP → `null`: tengono una
  sessione loro fuori da Topics, e un `sessionKey` nuovo partirebbe vuoto sotto
  una chat che mostra la storia.

Il server SHALL decidere sul fornitore RISOLTO del topic
(`server/providers/resolve-topic-provider.ts`), non sulla colonna. Il client
con `provider` nullo SHALL mostrare la voce e lasciar decidere il server.

#### Scenario: la tabella
- **WHEN** si chiama `forkModeFor` con `claude-code`, `claude-code-team`, `codex`, `topics`, `topics:opus`, `claude`, `openai`, `direct-x`, `openclaw`, `jcode`
- **THEN** le risposte sono `claude-cli`, `claude-cli`, `codex-cli`, `db-history`, `db-history`, `db-history`, `db-history`, `db-history`, `null`, `null`

#### Scenario: il ramo nativo ricorda
- **GIVEN** un topic sul runtime nativo diramato dopo 2 turni
- **WHEN** il nativo legge la storia del ramo (`nativeHistorySource` sul `sessionKey` del ramo)
- **THEN** riceve le 4 righe copiate, con le chiamate agli strumenti delle risposte

#### Scenario: un fornitore senza strada
- **GIVEN** un topic su `openclaw`
- **WHEN** si chiama la rotta
- **THEN** la risposta è 409 con `code: "fork_unsupported"`
- **AND** la barra dei suoi messaggi non ha `msg-action-fork`

### Requirement: CHAT-FORK-04 — La voce sul messaggio e `/fork [testo]` aprono il ramo, e il testo ne è il primo messaggio

Nella barra delle azioni del messaggio (`MessageBubble.tsx`, accanto a
Rigenera, `:420-429`) SHALL esserci un bottone `data-testid="msg-action-fork"`,
icona `GitBranch` di lucide, con `title` e `aria-label` tradotti («Dirama in una
nuova chat»). SHALL comparire solo sull'ultima parola della chat, `lastWord`
(`client/src/components/Chat/MessageList.tsx:470`, cioè l'ultima riga del ramo
attivo saltando gli avvisi di background in coda, come fa `isLastAssistant` per
Riprova, `:2052`), quando è una risposta `assistant` non `partial` e non una
riga della macchina. Durante un turno l'ultima parola è la risposta in corso, e
la voce non c'è; dopo un turno tagliato è la riga di stop, e la voce non c'è.
NON SHALL comparire sul coordinatore né quando `forkModeFor` dice `null`.

Il composer SHALL offrire `/fork` (voce in `SLASH_COMMANDS`,
`client/src/components/Chat/slashCommands.ts:33`, gestita in
`handleSlashCommand`, `ChatPane.tsx:965`). `/fork` NON SHALL essere in
`CLI_BUILTINS` (`server/context/adapt.ts:93`): non arriva mai alla CLI.

Voce e comando SHALL fare la stessa cosa: chiamare la rotta di CHAT-FORK-01,
aprire il ramo come tab permanente col fuoco (`topics:open-topic` con la
proiezione del server, `client/src/hooks/usePanelLifecycle.ts:1547-1583`) e,
se `/fork` ha un testo, spedirlo come primo messaggio del ramo con
`sendMessage(<sessionKey del ramo>, testo)`, la stessa strada di ogni invio.
Senza testo il ramo si apre col composer vuoto.

Un rifiuto SHALL comparire come esito del comando, tradotto per codice
(`turn_in_progress` → «Aspetta la fine del turno»; `fork_unsupported` →
«Questa chat non si può diramare»), e NON SHALL spedire niente né aprire tab.

Dopo il ramo le due chat SHALL andare ognuna per conto suo: un turno in una non
cambia la storia né la sessione dell'altra.

Dove cambiarla: scelta 1 (su quale riga sta la voce), scelta 2 (come si apre
il ramo), scelta 4 (voce assente e risposta di `/fork` durante un turno).

#### Scenario: la voce sta sull'ultima risposta finita
- **GIVEN** una chat con 2 turni finiti
- **WHEN** si passa sulla prima e sull'ultima risposta
- **THEN** `msg-action-fork` c'è solo sull'ultima
- **AND** non c'è su nessun messaggio dell'utente

#### Scenario: chat che finisce con un avviso di background: la voce sta sull'ultima risposta
- **GIVEN** una chat con 2 turni finiti seguiti da un avviso di background (riga `assistant` con un blocco `background-notice`)
- **WHEN** si passa sull'ultima risposta
- **THEN** `msg-action-fork` c'è, sulla risposta e non sull'avviso
- **AND** premendolo il ramo mostra i 4 messaggi dei 2 turni, senza l'avviso

#### Scenario: diramare dalla voce
- **GIVEN** una chat con 2 turni seminati (4 messaggi)
- **WHEN** si preme `msg-action-fork` sull'ultima risposta
- **THEN** la sidebar ha un topic nuovo «<nome> (ramo)», aperto e col fuoco, che mostra gli stessi 4 messaggi
- **AND** `GET /api/history` della chat d'origine dà ancora 4 messaggi

#### Scenario: `/fork` con un testo
- **GIVEN** una chat con 1 turno finito
- **WHEN** si scrive `/fork prova un'altra strada` e si invia
- **THEN** si apre il ramo, e il suo primo messaggio dopo la storia copiata è «prova un'altra strada»
- **AND** nella chat d'origine quel testo non compare

#### Scenario: `/fork` durante un turno
- **GIVEN** una chat con un turno in corso
- **WHEN** si invia `/fork`
- **THEN** compare «Aspetta la fine del turno»
- **AND** non nasce nessun topic e non si apre nessuna tab

### Requirement: CHAT-FORK-05 — Il ramo dice da dove viene, senza scriverlo nella conversazione

`Topic` SHALL portare
`forkedFrom?: { topicId: string | null; name: string; atMessageId: string }`,
proiettato dal server da `chat_forks` su `GET /api/topics`,
`GET /api/topics/:id` e `topic:created`, e assente per i topic che non sono
rami.

`MessageList` SHALL disegnare, subito dopo la riga `atMessageId`, un divisore
`data-testid="fork-origin-divider"` con «Diramata da <nome>». Il nome SHALL
aprire la chat d'origine (`topics:open-topic`); se l'origine non esiste più il
nome resta testo, senza collegamento. Se la riga `atMessageId` viene cancellata
nel ramo (CHAT-CONV-02) il divisore sparisce, senza errori.

Il divisore NON SHALL essere una riga di `messages`: non entra nella storia
consegnata al fornitore (HISTBUILD-01), nell'esportazione (CHAT-CONV-03) né nei
conteggi dei messaggi.

#### Scenario: il segno sta dove finisce la storia copiata
- **GIVEN** un ramo nato da «Refactor login» dopo 2 turni, con un turno nuovo fatto nel ramo
- **WHEN** si apre il ramo
- **THEN** `fork-origin-divider` sta fra la seconda risposta e il terzo prompt, e dice «Diramata da Refactor login»
- **AND** premendo il nome si apre «Refactor login»

#### Scenario: il punto dentro una corsa di strumenti
- **GIVEN** un ramo la cui storia copiata finisce con due righe di soli strumenti, che la lista disegna come UN elemento
- **WHEN** si apre il ramo
- **THEN** `fork-origin-divider` c'è, sotto quell'elemento

#### Scenario: l'origine cancellata
- **GIVEN** un ramo, e la riga della sua chat d'origine tolta da `topics` (chiudere una chat la archivia e la riga resta: l'origine archiviata si apre ancora dal nome)
- **WHEN** si legge il ramo (`GET /api/topics/:id`, `GET /api/topics`)
- **THEN** `forkedFrom.topicId` è nullo e `forkedFrom.name` è il nome dell'origine

#### Scenario: il segno non è conversazione
- **GIVEN** lo stesso ramo
- **WHEN** si esporta la conversazione e si conta `GET /api/history` del ramo
- **THEN** il file e il conteggio non contengono «Diramata da»

### Requirement: BGVIS-01 — Una chat in background ha un glifo suo, diverso da «risponde» e da «aspetta te»

Quando una chat non ha un turno aperto ma il suo ultimo turno ha lasciato lavoro
in background (riga `state:"background"` di `/api/topics/streaming`), la riga di
sidebar, la sua tab e, a cartella chiusa, il roll-up del progetto SHALL mostrare
il glifo `background`: lo stesso anello di `OrbitLoader`
(`client/src/components/Layout/StreamingIndicator.tsx:94`), arco **grigio**
(`text-app-text-tertiary`) che gira **lento**, reso da `LoaderSlot` con
`data-loader-state="background"`.

È un terzo stato e non va confuso con gli altri due: l'anello blu che gira dice
«sta rispondendo, l'invio si accoda», l'ambra ferma dice «tocca a te». Qui
nessuna delle due è vera: la chat è libera e il lavoro gira da sé.

Precedenza, sulla stessa riga o sullo stesso progetto: `waiting` (ambra) >
`working` (blu) > `background` (grigio). Con `prefers-reduced-motion` l'arco
SHALL stare fermo, come `.animate-orbit-spin` (`client/src/index.css:2900`).

Il tooltip SHALL dire quanti lavori e che la chat è libera (chiavi i18n it/en).
`ProjectElapsed` (`Sidebar/TopicTree.tsx:1295`) NON SHALL contare il lavoro in
background: misura il turno più vecchio in corso, e questo non è un turno.

Dove cambiarla: scelta 1 del blocco «Da decidere». Con «no» il glifo diventa lo
stesso `working` blu, e cade lo scenario «non si confonde».

#### Scenario: la riga di sidebar di una chat in background
- **GIVEN** `/api/topics/streaming` che risponde una sola riga
  `{topicId: T, state: "background", tasks: [2 task]}`
- **WHEN** la sidebar mostra la chat T
- **THEN** la riga di T contiene `[data-loader-state="background"]`
- **AND** non contiene `[data-loader-state="working"]` né `[data-loader-state="waiting"]`

#### Scenario: la tab e il progetto chiuso dicono lo stesso
- **GIVEN** la chat T in background, aperta in una tab, dentro il progetto P
- **WHEN** la cartella di P è chiusa in sidebar
- **THEN** la tab di T e la riga di P mostrano `[data-loader-state="background"]`

#### Scenario: un turno vero vince sul background
- **GIVEN** il progetto P con la chat T in background e la chat U che sta rispondendo
- **WHEN** la cartella di P è chiusa
- **THEN** la riga di P mostra `[data-loader-state="working"]`

### Requirement: BGVIS-02 — Il background non entra negli insiemi di streaming

Il lavoro in background SHALL essere uno stato **a parte** nello store dei
segnali (`client/src/state/signals.ts`). La risposta del poll
(`client/src/state/useSignalsSync.ts:110-139`) SHALL scrivere, nello stesso
giro, `backgroundWorkSessions` (per sessione, letto dal composer, invariato) e
il lavoro per topic `{sessionKey, tasks, lastSignalAt}` letto dai glifi, dalla
riga in chat e dagli agenti attivi (anche quello che una riga di turno porta in
`background`, BGVIS-05; quello no nell'insieme per sessione). `dropBackgroundWork(sessionKey)`
(`signals.ts:627`) SHALL svuotare entrambi.

Una chat in background NON SHALL entrare in `liveStreamTopics` né in
`hydratedStreamTopics`, e `useTopicLoading` (`signals.ts:1041`) SHALL restare
falso per lei. Altrimenti `reconcileServerStreams` e il composer la
tratterebbero come un turno in volo: invio bloccato o accodato, e una
riapertura fantasma del turno.

#### Scenario: l'invio resta libero
- **GIVEN** la chat T in background, composer con del testo
- **WHEN** si preme invio
- **THEN** il messaggio parte come in una chat a riposo (`decideComposerAction`
  → `send`, `client/src/components/Chat/composerAction.ts:78`), non si accoda

#### Scenario: lo Stop spegne tutto subito
- **GIVEN** la chat T in background, composer vuoto
- **WHEN** si preme lo Stop del composer e la route risponde `ok`
- **THEN** glifo, riga in chat e riga fra gli agenti attivi spariscono senza
  aspettare il poll successivo

### Requirement: BGVIS-03 — Le chat in background contano fra gli agenti attivi

`activeAgentRowsFrom` (`client/src/state/signals.ts:1313`) SHALL restituire,
oltre a `working`, `awaitingInput` e `finished`, un gruppo `background`: una riga
per chat (mai per task), solo per le chat a schermo (`visibleTopicSignalIds`),
mai anche in `working`. `Sidebar/AgentLines.tsx` SHALL mostrarlo sotto
un'intestazione propria («In background»), righe con
`data-testid="background-agent-row"`.

Il numero sul pulsante del menu (`Sidebar/IdentityBlock.tsx:189`) e la coda
della riga «Agenti attivi» SHALL contare `working + background`, calcolati da
una sola funzione sulle stesse righe, così numero ed elenco non possono
divergere (STATUSLINE-05).

Dove cambiarla: scelta 2 del blocco «Da decidere». Con «no» il gruppo resta
nell'elenco ma il numero torna `working.length`, come per `awaitingInput` e
`finished`.

#### Scenario: una chat in background è un agente attivo
- **GIVEN** la chat T con la sessione S in background, nessun turno aperto
- **WHEN** si calcola `activeAgentRowsFrom`
- **THEN** `background` contiene una riga `{id: T, kind: "topic"}`
- **AND** `working` non contiene T
- **AND** il numero sul pulsante del menu vale 1

#### Scenario: una chat archiviata non conta
- **GIVEN** la chat T in background ma archiviata
- **WHEN** si calcola `activeAgentRowsFrom`
- **THEN** `background` è vuoto

### Requirement: BGVIS-04 — In chat una riga dice chi si sta aspettando

Il server SHALL aggiungere alla riga `background` di `/api/topics/streaming` i
campi `tasks: {type, description}[]` e `lastSignalAt`, letti da `pp.background`
(`server/providers/claude/background-work.ts:59-70`) con una sonda nuova del
provider accanto a `backgroundState` (`server/providers/claude-code.ts:2786`) e
riportati da `backgroundStatusRows` (`server/providers/background-probes.ts:95`,
tipo `StreamingStatusRow`). Una `description` vuota SHALL ripiegare su `type`,
come fa già `claude-code.ts:2902`. La sonda SHALL riportare i task solo quando
`backgroundState` vale `running` (`hasLiveTasks`,
`server/providers/claude/background-work.ts:172`), e `[]` in `wake-queued`: una
lista oltre `BACKGROUND_WORK_CAP_MS` è già data per persa dal server e non va
mostrata come lavoro in corso. Un cron di sessione armato entro lo stesso tetto
(card 8b53d9d1) SHALL comparire fra i `tasks` come `{type: "cron", description:
"<schedule> (cron)"}`, e `lastSignalAt` non SHALL mai precedere l'armo: senza,
una chat che aspetta solo il suo cron mostrerebbe «sta per riprendere» per due
ore. Nessuna scrittura: DB, processo e orologi non cambiano.

La chat SHALL mostrare, come ULTIMA RIGA DEL TRASCRITTO, sotto l'ultimo
messaggio (il `Footer` di Virtuoso in
`client/src/components/Chat/MessageList.tsx`, prima delle bolle in coda), una
riga `data-testid="background-work-line"`: «In attesa di N lavori in
background:» seguita dai nomi, troncati. La riga scorre con la conversazione e
NON SHALL stare nel blocco del composer: comparendo e sparendo lì spostava il
composer e toglieva altezza al trascritto (Attilio, 29/09: «L'indicatore del
lavoro in background [...] dovrebbe, in realtà, apparire in fondo ai messaggi
della chat, perché dove è, al momento, è un po' fastidioso»). Con la vista in
fondo, la riga che compare, cambia altezza o sparisce SHALL lasciare la lista
incollata al fondo; con la vista risalita a leggere, SHALL non spostare ciò che
si sta leggendo. Con `tasks` vuoto (stato `wake-queued`, il task ha
risposto e la CLI sta per riprendere) la riga SHALL dire che la chat sta per
riprendere. Oltre `WORK_STALE_AFTER_MS` (`client/src/state/workLongevity.ts:22`,
10 min) da `lastSignalAt` la riga SHALL aggiungere da quanto non arrivano
notizie, con lo stesso trattamento «stale» di `LabeledLoader`.

La riga NON SHALL portare un secondo Stop: lo Stop è già quello del composer a
campo vuoto (`composerAction.ts:79`), e due comandi per la stessa cosa si
leggono come due cose diverse.

#### Scenario: la riga elenca i task
- **GIVEN** `/api/topics/streaming` intercettato con `page.route`, una riga
  `background` per la chat T con i task «Verifica build» e «Monitor deploy»
- **WHEN** si apre T
- **THEN** `[data-testid="background-work-line"]` è visibile e contiene entrambi i nomi

#### Scenario: la riga è l'ultima del trascritto e il composer non si muove
- **GIVEN** la chat T aperta con dei messaggi, vista in fondo, nessun lavoro in background
- **WHEN** il poll successivo riporta T in background
- **THEN** la riga compare dentro lo scroller del trascritto, sotto l'ultimo
  messaggio e sopra il composer
- **AND** il blocco del composer (`chat-input-area`) ha la stessa y e la stessa
  altezza di prima, a meno di 0,5px, e la lista resta in fondo
- **WHEN** il poll successivo non riporta più T
- **THEN** la riga sparisce, il composer resta dov'era e la lista resta in fondo

#### Scenario: la riga che compare non sposta chi legge
- **GIVEN** la chat T risalita con la rotellina oltre 600px dal fondo
- **WHEN** il poll riporta T in background e la riga compare in fondo al trascritto
- **THEN** il primo messaggio visibile non si sposta di più di 0,5px nei trenta
  frame che seguono

#### Scenario: la riga sparisce quando il lavoro finisce
- **GIVEN** la chat T con la riga visibile
- **WHEN** il poll successivo non riporta più T
- **THEN** la riga sparisce, e anche il glifo `background`

#### Scenario: il server porta i task
- **GIVEN** un provider finto registrato che riporta la sessione S in background
  con due task, uno senza `description`
- **WHEN** si chiama `backgroundStatusRows`
- **THEN** la riga di S ha `tasks` di lunghezza 2, e il task senza descrizione
  porta il suo `type` come nome
- **AND** ha `lastSignalAt` numerico

### Requirement: BGVIS-05 — Il lavoro in background resta nominato anche con un turno aperto

Un turno nuovo NON chiude il lavoro che un turno precedente ha lasciato in
background: la riga `background-work-line` di BGVIS-04 SHALL restare in chat,
con il nome del lavoro, per tutta la vita del lavoro, anche mentre un turno
nuovo della stessa chat è aperto (che risponda o che aspetti una risposta), e
SHALL sparire solo quando il lavoro finisce.

Il caso da cui nasce (29/09, chat `topic:33966f4e`): un Bash in background
lanciato alle 20:57:54Z, il turno chiuso e la riga visibile; alle 21:17:15Z un
«?» ha riaperto il turno e la riga è sparita, mentre il Bash girava fino alle
21:23:29Z. `backgroundStatusRows` saltava ogni sessione che aveva già una riga di
turno, e il client non trovava più niente da mostrare.

- Il server (`withBackgroundWork`, `server/providers/background-probes.ts`) SHALL
  lasciare UNA riga per sessione: la riga del turno (`streaming` o `waiting`)
  porta il campo `background: {tasks, lastSignalAt}` quando la sessione ha
  ancora task nominati; le sessioni senza turno aperto restano righe
  `background` come in BGVIS-04. Con `tasks` vuoto (il lavoro ha risposto e un
  turno lo sta per raccogliere) la riga del turno NON SHALL portare `background`:
  un turno aperto lo dice già.
- Il client (`readStreamingSnapshot`, `client/src/state/backgroundWork.ts`) SHALL
  mettere quel lavoro nella mappa per topic (riga in chat, glifi, agenti attivi,
  con la precedenza di BGVIS-01 e BGVIS-03: il turno vince) e NON nell'insieme
  per sessione del composer: con un turno aperto lo Stop è quello del turno.
- Con un turno aperto il tooltip della riga NON SHALL dire che la chat è libera.

#### Scenario: il server tiene il lavoro sulla riga del turno
- **GIVEN** una sessione S il cui turno ha lanciato un Bash in background ed è finito
- **WHEN** si chiama `withBackgroundWork` senza turni aperti
- **THEN** c'è una riga `background` di S che nomina il Bash
- **WHEN** un messaggio apre un turno di S
- **THEN** c'è UNA sola riga di S, `streaming`, e il suo `background.tasks` nomina il Bash
- **WHEN** il Bash finisce (snapshot vuoto e `task_notification`)
- **THEN** la riga di S non porta più `background`

#### Scenario: la riga in chat attraversa il turno nuovo
- **GIVEN** una chat su una CLI finta, un turno che lancia il lavoro «BGKEEP-JOB» e finisce
- **WHEN** la riga `background-work-line` lo nomina e dal composer parte un
  messaggio che apre un turno
- **THEN** la riga resta, campionata ogni 50 ms nella pagina, per tutto il turno
  e oltre un giro del poll di `/api/topics/streaming` che risponde il turno aperto
- **AND** resta quando il turno finisce
- **WHEN** il lavoro finisce
- **THEN** la riga sparisce

### Requirement: BGVIS-06 — Un Monitor in corso si vede come Monitor, con da quanto gira, da subito

Il lavoro in background SHALL essere visibile per tutta la sua vita come in
Claude Code: ogni task nominato con la sua descrizione e da quanto gira, un
Monitor riconoscibile come tale, anche mentre il turno che l'ha armato è ancora
aperto, e SHALL sparire quando il lavoro finisce o scade.

Il caso da cui nasce (30/09, chat `topic:33966f4e`, CLI 2.1.285): il Monitor
«batch 4 results», armato alle 20:53:52Z e scaduto alle 21:13:53Z, restava nella
riga di BGVIS-04/05 come un generico «lavoro in background» (la CLI lo elenca
come `local_bash`), senza tempo, e compariva solo al poll successivo (15 s).

- Il tracker (`server/providers/claude/background-work.ts`) SHALL datare ogni
  task alla prima volta che lo vede (snapshot o `task_started`) e tenere quella
  data finché il task vive: lo snapshot che la CLI ristampa a ogni cambio NON
  SHALL azzerarla. Un task il cui `task_started` porta il `tool_use_id` di una
  chiamata `Monitor` SHALL uscire come `type: "monitor"`. Dopo un riavvio la
  data SHALL non essere più recente dell'ultima scrittura del figlio
  (`datedByLastWrite`): stdout non data le sue righe, e un tempo più corto del
  vero è meglio di uno più lungo.
- `BackgroundTaskSummary` (`shared/background-work.ts`) SHALL portare
  `startedAt` (epoch ms, facoltativo: un server più vecchio non lo manda).
- Ogni volta che l'insieme nominato cambia (un task entra o esce, un Monitor è
  riconosciuto) il server SHALL mandare `background:changed {topicId,
  sessionKey}` a tutte le finestre, e il client SHALL rileggere
  `/api/topics/streaming` subito invece di aspettare il giro dei 15 s.
- La riga `background-work-line` SHALL rendere ogni task come
  `data-testid="background-work-task"` con `data-type`: il Monitor con l'icona
  lucide `Activity` del tool Monitor (etichetta i18n `chat.background.monitor`),
  e accanto a ogni task con `startedAt` il tempo di corsa
  (`data-testid="background-work-running"`: secondi sotto il minuto, poi
  `formatElapsedCompact`). Stesso posto (ultima riga del trascritto), stesso aspetto.
- Nessuno Stop per singolo task: la CLI 2.1.286 ha la richiesta di controllo
  `stop_task` nel protocollo stream-json, ma che risponda in modalità `--print`
  non è verificato; lo Stop resta quello del composer.

#### Scenario: una chat vera, ripassata dal provider
- **GIVEN** lo stdout di 33966f4e fra le 20:53 e le 21:14Z, anonimizzato
  (`tests/fixtures/claude-cli-2.1.285-monitor-wakes.ndjson`), fatto passare da
  `handleStreamEvent` con le sveglie adottate
- **WHEN** la CLI stampa il `task_started` del Monitor, a turno aperto
- **THEN** `backgroundWorkDetail` lo nomina `{type: "monitor", description,
  startedAt}` con la data dello snapshot che l'ha elencato
- **AND** lo nomina uguale, stessa data, a turno chiuso, attraverso ogni sveglia
  e ogni turno aperto dopo, fino alla scadenza
- **WHEN** lo snapshot si svuota e il task riferisce (scadenza)
- **THEN** non nomina più niente

#### Scenario: la riga lo mostra durante il turno che l'ha armato, dopo, e lo toglie alla fine
- **GIVEN** una chat su una CLI finta (`helpers/fake-claude-monitor.ts`) un cui
  turno resta aperto e arma il Monitor «MONWATCH-JOB» subito dopo un poll di
  stato, a refresh di `stream:start` già passato: il poll dopo è a ~15 s, quindi
  solo il push `background:changed` può nominarlo in tempo
- **THEN** entro 5 s, con lo Stop del turno ancora visibile, la riga ha un
  `background-work-task` con `data-type="monitor"`, l'icona «Monitor» e un tempo
- **WHEN** il turno finisce
- **THEN** la riga lo nomina ancora
- **WHEN** il Monitor finisce (`stream ended`, con l'ultimo evento nella notifica)
- **THEN** la risposta ha un banner `source: "monitor"` che dice che quel Monitor
  è finito e come, con l'ultimo evento, e la riga sparisce

### Requirement: BGVIS-07 — Un comando lanciato con `run_command` è lavoro in background della chat

Un processo che l'agente lancia con il tool Topics `run_command` SHALL comparire
nella riga `background-work-line` di BGVIS-04/05/06 per tutta la sua vita, come
un task della CLI, e SHALL sparire quando il processo esce.

Il caso da cui nasce (30/09, Attilio su una chat viva: «qua anche non sta uscendo
nessuna ui, non so che sta facendo»): il turno era finito, l'agente aveva
lanciato con `run_command` un ciclo che aspettava tre lavori («this topic gets a
message when it ends») e la chat aspettava lui. La riga leggeva solo le sonde dei
provider (`server/providers/background-probes.ts` → `claude/background-work.ts`:
Agent, Bash, Monitor della CLI), e un comando vive nel registro dei processi di
Topics (`server/routes/processes.ts`), non nella CLI: la chat non mostrava niente.

- Quali: OGNI comando della sessione ancora in corsa, con o senza sveglia dovuta,
  come Claude Code elenca ogni shell in background in corsa, TRANNE un server
  (senza sveglia e in ascolto su una porta), che la chat mostra come server e
  non aspetta (BGVIS-08). Lo dice il registro (`commandBackgroundWork` in
  `server/routes/processes.ts`), che `withBackgroundWork` riceve dalla route
  `/api/topics/streaming` accanto ai task del provider: con turno aperto nel
  campo `background` della riga del turno, senza in una riga `background`. Una
  sessione con soli comandi ha `lastSignalAt: 0` (nessuna notizia della CLI che
  possa invecchiare: il server guarda il processo da sé).
- Forma: `BackgroundTaskSummary` (`shared/background-work.ts`) con `type:
  "command"`, `description` = la `description` data a `run_command` (parametro
  facoltativo nuovo) oppure la prima riga del comando, tagliata
  (`commandLabel`), `startedAt` = l'avvio del processo, `processId` e `wakes`
  (la sua fine sveglierà la chat). Lo stesso nome va nel pannello Processi e
  nella sveglia.
- Freschezza: all'avvio e alla fine di un comando il registro SHALL mandare
  `background:changed {topicId, sessionKey}` come per i task della CLI
  (BGVIS-06), non aspettare il poll dei 15 s.
- Riavvio: un comando riadottato al boot (vivo, stesso `lstart`) resta nella
  riga; uno trovato morto si chiude al boot e non compare.
- Riga: `background-work-task` con `data-type="command"` e `data-process-id`,
  l'icona lucide `SquareTerminal` (etichetta i18n `chat.background.command`), il
  tempo di corsa e, se una sveglia è dovuta, «sveglia la chat quando finisce»
  (`background-work-wakes`). Il nome è un bottone (`background-work-open`) che
  apre il log del processo come pane della finestra di progetto della chat
  (evento `open-process-log`, con lo scoping per progetto di `open-file-diff`).
- Stop: lo Stop del composer ferma il lavoro della CLI, non i comandi (vivono
  fuori dalla CLI apposta). Una chat con soli comandi NON SHALL entrare
  nell'insieme per sessione del composer (`composerStopsWork`,
  `client/src/state/backgroundWork.ts`): lì lo Stop rispondeva «niente da
  fermare». Lo Stop di un comando è nel pannello Processi che la riga apre.
- Sveglia: la risposta alla sveglia SHALL portare in cima un banner `woken` con
  `source: "command"`, il nome del comando, il suo `exitCode` (null = nessuno
  registrato, detto «sconosciuto», mai un successo) e la sua ultima riga di
  output come `text`, come fa la fine di un Monitor. Il banner viaggia anche su
  `stream:start`. Non cambia chi rimanda un turno tagliato da un'interruzione:
  `outageCutNotResent` ignora il banner di un comando.

#### Scenario: il registro nomina il comando, lo spinge, e lo toglie
- **GIVEN** un comando lanciato dalla route di `run_command` con una
  `description`
- **THEN** `commandBackgroundWork` lo nomina `{type: "command", description,
  processId, wakes: true, startedAt}` ed è partito un `background:changed`
- **AND** `withBackgroundWork` senza turni dà una riga `background` con quel task
  e `lastSignalAt: 0`; con un turno aperto, UNA riga di turno che lo porta in
  `background`
- **WHEN** il comando esce
- **THEN** non è più nominato ed è partito un secondo `background:changed`

#### Scenario: dopo un riavvio resta solo chi è vivo
- **GIVEN** uno `scripts.json` con un comando vivo (stesso `lstart`) e uno morto
- **WHEN** il registro si carica in un processo nuovo
- **THEN** nomina solo quello vivo

#### Scenario: una chat vera, dal turno alla sveglia
- **GIVEN** una chat in una finestra di progetto su una CLI finta
  (`helpers/fake-claude-command.ts`) un cui turno resta aperto e chiama
  `run_command` subito dopo un poll di stato
- **THEN** entro 5 s, con lo Stop del turno visibile, la riga ha un task
  `data-type="command"` con il nome, l'icona, un tempo e «sveglia la chat»
- **WHEN** il turno finisce
- **THEN** la riga lo nomina ancora, il tempo avanza e il composer non offre Stop
- **WHEN** si clicca il nome
- **THEN** il log del processo si apre come tab della finestra di progetto
- **WHEN** il comando esce
- **THEN** la riga sparisce e la risposta alla sveglia ha un banner `source:
  "command"` con il nome, `exit 0` e l'ultima riga di output

### Requirement: BGVIS-08 — Un server lanciato dalla chat si vede come server, non come lavoro che la chat aspetta

Un comando lanciato con `run_command` che NON sveglia la chat (`wake: false`) e
il cui albero di processi ascolta su almeno una porta TCP SHALL essere un
**server** della chat: non lavoro in background che la chat aspetta. Un comando
che sveglia la chat resta lavoro atteso (BGVIS-07) anche se ascolta su una
porta; uno che non ascolta su niente pure.

Il caso da cui nasce (01/10, Attilio su una chat viva: «questa sessione ha la
chat in attesa di un lavoro in background ma invece dovrebbe essere un processo
Topics e si dovrebbe vedere che il server è attivo»): l'agente aveva lanciato
`python3 -m http.server 8777 --bind 127.0.0.1` con `run_command` senza sveglia;
la chat diceva «In attesa di 1 lavoro in background» con l'anello grigio sulla
tab per tutta la vita del server, e `GET /api/processes?topicId=` di quella
chat rispondeva `[]` mentre la chat nominava il processo.

- Riconoscimento, misurato e non indovinato dal testo del comando: le porte in
  ascolto dell'albero del processo (`lsof`, `server/lib/command-services.ts`),
  guardate da un timer che gira solo mentre c'è un comando senza sveglia in
  corsa (2 s all'inizio, raddoppio fino a 30 s finché niente cambia, di nuovo
  2 s a ogni avvio). Finché un comando senza porta ha meno di 2 minuti, il
  raddoppio SHALL fermarsi a 5 s: un server che compila a lungo si vede entro
  5 s dal momento in cui apre la porta. La route di stato NON SHALL lanciare `lsof`.
- Un server NON SHALL comparire fra i `tasks` di `/api/topics/streaming`: niente
  riga `background-work-line`, niente glifo `background` su riga, tab e
  progetto, niente riga fra gli agenti attivi, e lo Stop del composer non lo
  riguarda. La risposta SHALL portare a parte `services: [{topicId, sessionKey,
  services}]` (`TopicServices`, `shared/background-work.ts`).
- In chat, nel `Footer` del trascritto sotto la riga di BGVIS-04, una riga
  compatta per server `data-testid="running-service-row"` (non un banner):
  «Server · 127.0.0.1:8777 · nome» con **Apri** (una tab del browser di Topics
  sull'indirizzo, attraverso `openLink` come ogni link della chat), **Log** (il
  log del processo nella finestra di progetto, evento `open-process-log`) e
  **Ferma** (`POST /api/scripts/:id/stop`). Entra con `reveal-in`.
- Dal vivo: un avvio, una fine e una porta che compare o sparisce SHALL mandare
  `background:changed`, come per BGVIS-06/07.
- Fine: per `SERVICE_END_SHOWN_MS` (8 s) dopo l'uscita il server resta fra i
  `services` con `ended: {at, exitCode, stopped}`; la riga dice come è finito
  («Server fermato», «Server terminato (exit N)») e sparisce da sé dopo 5 s.
- Un server che sta finendo (fermato, o col processo morto e la riga non ancora
  chiusa: uno riadottato dopo un riavvio si chiude al controllo del pid ogni
  3 s) SHALL tenere i suoi indirizzi anche se il timer non vede più la porta:
  non torna fra i `tasks` e la sua fine resta detta con `ended`.
- `GET /api/processes?topicId=` SHALL elencare, prima dei sotto-agenti, i
  processi `run_command` di quella chat (in corsa e recenti), con le porte.

#### Scenario: il registro distingue un server da un comando atteso
- **GIVEN** un comando senza sveglia che avvia un vero server HTTP su una porta
  libera, e uno identico con la sveglia
- **WHEN** il timer vede la porta del primo
- **THEN** il primo è fra i `services` della chat con `listen: [{host:
  "127.0.0.1", port}]` e non fra i `tasks`; il secondo resta fra i `tasks`
- **AND** `GET /api/processes` della chat lo elenca `running` con la porta
- **WHEN** lo si ferma
- **THEN** è fra i `services` con `ended.stopped` e senza exit code
- **AND** il server non risponde più sulla sua porta prima che il test finisca

#### Scenario: un server che sta finendo non torna lavoro atteso
- **GIVEN** il timer conosce le porte di tre server
- **WHEN** un passaggio non vede più nessuna porta, e del primo il processo è
  morto, il secondo è stato fermato, il terzo è vivo
- **THEN** il primo e il secondo tengono i loro indirizzi e il terzo li perde
- **AND** chiusa la riga del primo, i `services` dicono come è finito

#### Scenario: una chat vera avvia un server
- **GIVEN** una chat in una finestra di progetto su una CLI finta
  (`helpers/fake-claude-service.ts`) che lancia con `run_command` senza sveglia
  un vero server HTTP su una porta libera
- **THEN** la chat ha UNA riga `running-service-row` con `127.0.0.1:<porta>` e
  il nome, nessuna `background-work-line`, nessun glifo `background` sulla tab
  e nessuno Stop nel composer
- **AND** `GET /api/processes?topicId=` lo elenca `running` con la porta
- **WHEN** si clicca Apri
- **THEN** parte una `browser:open-tab` su `http://127.0.0.1:<porta>/` per quella chat
- **WHEN** si clicca Log
- **THEN** il log del processo si apre come tab della finestra di progetto
- **WHEN** si clicca Ferma
- **THEN** la riga dice «Server fermato» e poi sparisce

#### Scenario: con la sveglia resta lavoro atteso
- **GIVEN** la stessa CLI finta che lancia lo stesso server CON la sveglia
- **WHEN** il server risponde sulla sua porta
- **THEN** la riga `background-work-line` lo nomina con «sveglia la chat» e non
  c'è nessuna `running-service-row`

### Requirement: CHAT-NTOOL-04 — Il `bash` nativo manda la coda del suo output mentre gira

Il runtime nativo SHALL rendere visibile l'output di un `bash` mentre il comando
gira, attraverso il canale che gli altri provider usano già:
`handler.onToolUpdate(toolCallId, partialResult)`, che `chat.ts:2765` trasmette
come `stream:tool_update`.

- `ToolContext` (`server/providers/native/tools.ts:38`) SHALL avere un campo
  opzionale `onOutput?: (tail: string) => void`. Assente = comportamento di oggi.
- Il caso `bash` (`tools.ts:565`) SHALL passarlo a `runCommand`. `grep`
  (`tools.ts:585`) e l'altro chiamante (`tools.ts:593`) NON SHALL passarlo.
- `agent-loop.ts:884` SHALL costruire il contesto della singola chiamata con
  `onOutput: (s) => handler.onToolUpdate?.(t.id!, s)`.
- Ogni chiamata SHALL portare la coda **intera** corrente, non il pezzo nuovo:
  il client sostituisce `result` (`useChat.ts:1210`), e con la sostituzione
  applicare tutti i frame o solo l'ultimo lascia lo stesso stato.
- La coda SHALL venire da un buffer suo, degli ultimi 16 KB, e NON da `out`:
  `out` smette di crescere a `MAX_OUTPUT_CHARS * 2` (`tools.ts:285`), e una coda
  ritagliata da lì resterebbe ferma a metà su un comando verboso. Quando il
  buffer taglia la testa, la coda SHALL cominciare dopo il primo `\n`, mai a
  metà riga. Una sola riga più lunga del buffer (una barra `\r`, un JSON su
  una riga) non ha un inizio dove tagliare, nemmeno quando il suo `\n` la
  chiude: resta com'è, dal primo carattere intero, e una coda vuota non segue
  mai una non vuota. I 16 KB sono byte, non caratteri.
- Le chiamate SHALL essere al massimo una ogni 250 ms, con un'ultima chiamata
  in coda per l'output arrivato dentro la finestra. Alla chiusura del comando
  (`chiudi`, `tools.ts:298`) la chiamata in coda SHALL essere annullata: l'esito
  viaggia su `onToolResult`, e nessun parziale SHALL arrivare dopo.
- Un `onOutput` che lancia SHALL essere ignorato: l'esito del tool NON SHALL
  cambiare.

#### Scenario: un comando lento si vede mentre gira
- **GIVEN** `executeTool('bash', { command: 'for i in 1 2 3; do echo L$i; sleep 0.4; done' }, { workspace, onOutput })`
- **WHEN** il comando gira
- **THEN** `onOutput` è chiamato almeno due volte prima che la promessa si risolva
- **AND** una chiamata intermedia contiene `L1` e non `L3`
- **AND** il `content` finale è identico a quello di una chiamata senza `onOutput`

#### Scenario: un comando verboso non congela la coda
- **GIVEN** `bash` con `seq 1 20000; sleep 1` (circa 109 KB, oltre il tetto di `out`)
- **WHEN** arriva una chiamata durante lo `sleep`
- **THEN** la coda termina con `20000`
- **AND** è lunga al massimo 16 KB e comincia a inizio riga

#### Scenario: un output non ASCII resta nei 16 KB
- **GIVEN** `bash` che stampa 3000 righe `✓ passes test number N ██████` e poi `sleep 1`
- **WHEN** arriva una chiamata durante lo `sleep`
- **THEN** la coda è lunga al massimo 16 KB in byte, termina con la riga 3000 e comincia a inizio riga

#### Scenario: una riga più lunga del buffer, poi silenzio
- **GIVEN** `bash` che stampa una barra `\r` di circa 40 KB, chiusa dal suo `\n`, e poi `sleep 1`
- **WHEN** arrivano le chiamate
- **THEN** nessuna porta una coda vuota
- **AND** l'ultima termina con l'ultimo ridisegno della barra

#### Scenario: niente dopo l'esito
- **GIVEN** un `bash` che stampa di continuo per 1 s e poi esce
- **WHEN** la promessa si è risolta e passano altri 500 ms
- **THEN** il numero di chiamate a `onOutput` non è cambiato
- **AND** le chiamate totali sono al massimo 5

#### Scenario: un callback rotto non rompe il tool
- **GIVEN** un `onOutput` che lancia a ogni chiamata
- **WHEN** gira `echo ok`
- **THEN** il tool risponde `ok`, senza errore

### Requirement: CHAT-TOOL-08 — La riga di un comando in corso mostra le sue ultime 8 righe

Una riga `shell` con stato `pending` o `running`, il cui `detail` tipizzato non
ha `output`, e con `tc.result` stringa non vuota, SHALL mostrare nel corpo
aperto le **ultime 8 righe** di `tc.result`, sotto il comando. Vale per ogni
provider che manda `stream:tool_update`, quando la sua riga è `shell`: il
nativo sì. Codex e ACP no (corretto dopo la review del 27/09): codex chiama la
riga col comando (`codex.ts:883-884`) e ACP col titolo (`acp/translate.ts:218`),
quindi la riga resta `unknown`. Tipizzarle come `shell` è fuori da questa change.

- Il taglio SHALL stare in una funzione pura raggiungibile da `bun:test`
  (in `client/src/components/Chat/toolDetail.ts` o accanto), che restituisce le
  righe da mostrare e se ne sono state nascoste sopra.
- Una riga ridisegnata con `\r` (le barre di avanzamento, es. `curl`) SHALL
  contare come il suo ultimo ridisegno, non come un muro di testo.
- Quando le righe sono più di 8, SHALL comparire un avviso che sopra c'è altro
  output, SENZA numero: la coda nativa è già tagliata dal server e un conteggio
  sarebbe falso. Il testo passa dall'i18n (`i18n-it.ts`, `i18n-en.ts`).
- Il blocco SHALL avere `data-testid="shell-running-tail"`, distinto da
  `shell-live-output` (la shell in background, `ToolCards.tsx:96`) e da
  `tool-call-result` (l'output finale).
- Quando la riga chiude, il corpo SHALL mostrare l'output definitivo del
  `detail` come oggi; la coda sparisce. L'apertura e la chiusura del corpo
  restano quelle di CHAT-TOOL-03.

#### Scenario: venti righe, se ne vedono otto
- **GIVEN** una riga `Bash` in `running` con `detail = { type: 'shell', command }` e `result` di 20 righe `r1…r20`
- **WHEN** si risolve cosa mostrare
- **THEN** si mostrano `r13…r20`
- **AND** è segnalato che sopra c'è altro

#### Scenario: una barra di avanzamento è una riga
- **GIVEN** `result = "scarico\n 10%\r 50%\r100%\nfatto"`
- **THEN** le righe mostrate sono `scarico`, `100%`, `fatto`

#### Scenario: la coda segue il comando e lascia il posto all'esito
- **GIVEN** la chat su `:13334` e, via `page.routeWebSocket`, un `stream:tool_call` `Bash` in `running`
- **WHEN** arrivano due `stream:tool_update` con 12 e poi 20 righe
- **THEN** il corpo auto-aperto mostra in `shell-running-tail` le ultime 8 righe del primo, poi del secondo
- **AND** dopo `stream:tool_result` con `detail.output` il `shell-running-tail` non c'è più e `tool-call-result` mostra l'output definitivo

### Requirement: CHAT-TOOL-09 — La coda raggiunge anche la finestra da cui hai scritto, e non scrive mai su una riga chiusa

`stream:tool_update` SHALL entrare in `SENDER_ALSO_SEES`
(`client/src/hooks/senderAlsoSees.ts:44`). Rispetta la regola del file: scrive
uno stato fisso (sostituisce `result`), e riceverlo due volte lascia lo stesso
stato.

Nella finestra mittente l'esito arriva sull'SSE e il parziale su WS: due canali
senza ordine fra loro. Per questo `flushToolUpdates` (`useChat.ts:1210`) SHALL
scrivere `result` solo su una riga in `pending` o `running`. La parte di stato
dell'evento (`toolUpdatePatch`) resta com'è.

#### Scenario: la finestra da cui hai scritto vede la coda
- **WHEN** si chiede `senderAlsoSees('stream:tool_update')`
- **THEN** la risposta è `true`

#### Scenario: un parziale in ritardo non cancella l'esito
- **GIVEN** una riga `Bash` già in `success` con il suo `result` finale
- **WHEN** arriva un `stream:tool_update` per la stessa riga
- **THEN** `result` resta quello finale
- **AND** sulla chat di `:13334`, con la riga senza `detail` tipizzato (come arriva dall'SSE nella finestra mittente), `tool-call-result` mostra ancora l'output finale

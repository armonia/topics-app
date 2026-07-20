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

#### Scenario: Hovering a checkpoint reveals rollback button
- **GIVEN** the checkpoint timeline is expanded with entries listed
- **WHEN** the user hovers over a checkpoint entry
- **THEN** a rollback button (rotate-ccw icon) appears on the right side of the entry
- **AND** the entry background highlights on hover

#### Scenario: Clicking rollback shows confirmation dialog
- **GIVEN** the rollback button is visible on a checkpoint entry
- **WHEN** the user clicks the rollback button
- **THEN** a browser confirmation dialog appears explaining the rollback action
- **AND** the dialog mentions the checkpoint description and message count
- **AND** if a git hash exists the dialog mentions the abbreviated git hash

#### Scenario: Confirming rollback truncates to checkpoint
- **GIVEN** the rollback confirmation dialog is displayed
- **WHEN** the user confirms the dialog
- **THEN** the checkpoint list truncates to include only checkpoints up to and including the selected one
- **AND** later checkpoints are removed from the timeline

#### Scenario: Cancelling rollback preserves current state
- **GIVEN** the rollback confirmation dialog is displayed
- **WHEN** the user cancels the dialog
- **THEN** no rollback occurs
- **AND** the checkpoint list remains unchanged

#### Scenario: Rollback failure shows error alert
- **GIVEN** the user confirms a rollback
- **WHEN** the rollback API call fails
- **THEN** an alert dialog displays a "Rollback failed" message with the error details

#### Scenario: Successful rollback with git warning shows notice
- **GIVEN** the user confirms a rollback on a checkpoint with a git hash
- **WHEN** the rollback succeeds but returns a git warning
- **THEN** an alert dialog displays "Rolled back successfully" with the warning note

#### Scenario: Collapsing the timeline hides checkpoint details
- **GIVEN** the checkpoint timeline is expanded
- **WHEN** the user clicks the compact bar again
- **THEN** the detailed checkpoint list collapses
- **AND** only the compact bar with count and dots remains visible


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

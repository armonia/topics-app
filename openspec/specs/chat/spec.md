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

The system SHALL register the Claude Code CLI as an AI provider named `claude-code`, declaring the capabilities `streaming`, `tools`, `sessions` and `abort`, and SHALL expose every registered provider over `GET /api/providers`.

#### Scenario: The providers endpoint lists the registered providers
- **GIVEN** the server has run provider initialisation
- **WHEN** a client issues `GET /api/providers`
- **THEN** the response SHALL carry a `providers` array with at least one entry
- **AND** every entry SHALL expose `name`, `connected` and `capabilities`

### Requirement: CCPROV-02 — Streamed Turns Render Text And Tool Cards

> Promoted from `2026-05-16-claude-code-provider`, rewritten from provider-callback wording to the visible end of the stream, which is what the covering tests assert. The original scenarios about `onTextDelta`/`onToolStart`/`onToolResult` fan-out, error propagation from the child process and per-session serialisation of concurrent messages live at unit level and are claimed by no test id.

The system SHALL render a streamed assistant turn incrementally: the assistant text as it arrives, and one tool card carrying the tool's name for every tool the turn uses, placed at the offset in the text where the call happened. A card SHALL render whether the call succeeded or failed, and a turn that uses several tools SHALL render one card per tool.

#### Scenario: A streamed turn renders its text and a card for the tool it used
- **GIVEN** an open topic with the message input ready
- **WHEN** the user sends a message and the turn streams back text plus a `Read` (or `Bash`) tool call
- **THEN** the assistant text SHALL appear in the message area
- **AND** a tool card naming that tool SHALL appear alongside it

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

### Requirement: CHAT-RND-01 — Syntax Highlighting In Code Blocks

> Promoted from `2026-07-10-chat-rendering-parity` and translated into English. The safe-degradation scenario (unknown language, blocks over 50 000 characters, tokenizer failure) is not restated: no test exercises it. The behaviour is in `highlightCode`, which returns null in those cases and leaves the block plain.

Code blocks in messages whose fence names a known language SHALL be rendered with syntax highlighting.

#### Scenario: A javascript fence is tokenised
- **GIVEN** an assistant message containing a fence marked `javascript` with a keyword and a comment
- **WHEN** the message is rendered
- **THEN** the code block SHALL contain distinct token elements for the keyword and for the comment

### Requirement: CHAT-CONV-01 — Regenerate As A Sibling Branch

> Promoted from `2026-07-11-chat-conversation-pack` and translated into English. The "regenerate is not offered during streaming" scenario was rewritten: what ships is a per-message guard (the action is absent on a partial message) plus a 409 from the endpoint, and no test claims the streaming case, so only the offered-on-a-completed-message half is stated.

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

The system SHALL export the active thread as a downloadable Markdown file from the composer's tools menu.

#### Scenario: Export downloads a markdown file carrying the thread
- **GIVEN** a topic with messages
- **WHEN** the user opens the composer's tools menu and chooses Export conversation
- **THEN** a file whose name ends in `.md` SHALL be downloaded
- **AND** its content SHALL contain the messages of the active thread

### Requirement: REAL-TC-01 — Tool Calls Stored In History Render As Cards

> Promoted from `2026-05-16-real-e2e-tool-calls-and-media`; the test ids were corrected against what ships. The row is `[data-testid="tool-call-row-<id>"]` (the change said `tool-call-<id>`), and the error status is an attribute on that row, `data-status="error"`, not a separate `[data-testid="tool-call-status"]` element.

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

#### Scenario: A background Bash that failed leaves nothing behind
- **GIVEN** a background `Bash` tool result flagged as an error
- **WHEN** the result is classified for its effect on the registry
- **THEN** no shell SHALL be started

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

A sub-agent spawned from a topic chat SHALL report its exit into that conversation, so the chat that promised an update reaches an end instead of hanging on a promise nobody can keep. The report SHALL prefer the child's own final text and SHALL distinguish a failure from a clean but silent finish.

#### Scenario: The child's own words are the body
- **GIVEN** an exit carrying the child's final assistant text
- **WHEN** the body is formatted
- **THEN** it SHALL be that text, trimmed
- **AND** it SHALL be used even when the exit code is non-zero

#### Scenario: No output, and the exit code says why
- **GIVEN** an exit with empty or whitespace-only output and a non-zero exit code
- **WHEN** the body is formatted
- **THEN** it SHALL be an italic note naming that exit code and saying no output was recovered

#### Scenario: A clean but silent finish gets the neutral note
- **GIVEN** an exit with no output and an exit code of zero, or an unknown exit code
- **WHEN** the body is formatted
- **THEN** it SHALL be the neutral "finished with no output" note, not a failure

#### Scenario: The report names the sub-agent above its body
- **GIVEN** a formatted exit for a named sub-agent
- **WHEN** the chat message is composed
- **THEN** it SHALL open with a bold header naming that sub-agent, with the body below it
- **AND** with no result the status note SHALL be embedded in the same shape

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

The exit report is persisted and broadcast as an ordinary new message while the PARENT's turn is still open. The client SHALL place it by identity — the id announced when the turn started — and never by position, so the report does not take over the live bubble and the rest of the answer keeps landing in its own.

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

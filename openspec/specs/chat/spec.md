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

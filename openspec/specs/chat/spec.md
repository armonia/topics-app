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

A sub-agent spawned from a topic chat reports its exit into that conversation, so the chat that promised an update reaches an end instead of hanging on a promise nobody can keep. The body of that report SHALL prefer the child's own final text, and SHALL distinguish a failure from a clean but silent finish.

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
l'avesse chiesto. A coda ferma il comando che manda subito NON SHALL essere
offerto.

Un messaggio in coda SHALL essere MODIFICABILE e RIMUOVIBILE prima di partire.
SHALL esistere un comando per mandarlo SUBITO senza aspettare la fine del turno.

Alla ripresa la coda SHALL ripartire dalla TESTA: nessun sorpasso. Più messaggi
accodati SHALL partire INSIEME, in UN SOLO turno, e comparire come UNA bolla:
estrarne uno per volta significa tre giri di modello e tre volte il contesto per
una cosa sola.

Un COMANDO NON SHALL essere accodato: agisce subito.

Un rifiuto per «turno già in volo» SHALL mettere il messaggio in TESTA alla coda e
farlo partire a fine turno, e NON SHALL lasciare a schermo una bolla fantasma.

#### Scenario: si preme ferma
- **GIVEN** un messaggio in coda e il turno fermato
- **THEN** il messaggio SHALL restare in coda

#### Scenario: tre messaggi accodati
- **GIVEN** tre messaggi in coda e un turno che finisce
- **THEN** SHALL partire insieme, in un turno solo

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

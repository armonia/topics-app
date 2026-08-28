## Purpose

Specifies behavioral scenarios for the command palette, keyboard shortcuts, theme management, and application settings including persistence and graceful degradation.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The application is loaded with at least one topic visible
- No modal dialogs are open
## Requirements
### Requirement: CMD-01 — Command Palette, Keyboard Shortcuts, Theme & Settings

The system SHALL provide a command palette accessible via keyboard shortcut for topic search, file search, message search, and action execution; a keyboard shortcuts help modal; theme switching with persistence; and a settings panel with font size, message density, and push notification controls.

La DIDASCALIA di una scorciatoia SHALL nominare un tasto che esiste su QUELLA
tastiera. Il gesto funzionava gia' ovunque — chi ascolta accetta `metaKey ||
ctrlKey` — ma su Windows l'interfaccia scriveva `⌘K`, e il tasto mela li' non
c'e': segnalato il 2026-08-26 sulla build installata, dove `Ctrl+K` apriva la
palette mentre la scritta indicava altro. Le didascalie sono il modo in cui le
scorciatoie si IMPARANO, e sono la prima cosa sulla schermata di benvenuto: una
che nomina il tasto sbagliato non rallenta, insegna una cosa falsa.

Il separatore SHALL seguire la convenzione del sistema: nessuno fra i glifi di
macOS (`⌘⇧C`, che sono simboli e affiancati si leggono), il piu' fra le parole di
Windows (`Ctrl+Shift+C`, perche' `CtrlShiftC` non si legge).

#### Scenario: la didascalia su una tastiera senza tasto mela
- **GIVEN** un sistema che non ha il tasto Command
- **THEN** la didascalia SHALL nominare `Ctrl`, e SHALL separare i tasti col piu'

#### Scenario: Open command palette with keyboard shortcut
- **GIVEN** the application is loaded with no modals open
- **WHEN** the user presses Cmd+K
- **THEN** the command palette opens as a dialog overlay
- **AND** the search input is focused and ready for typing

#### Scenario: Command palette has proper dialog semantics
- **GIVEN** the command palette is open
- **WHEN** the user inspects the overlay
- **THEN** the overlay has a dialog role for accessibility
- **AND** the search input is the focused element

#### Scenario: Close command palette with Escape key
- **GIVEN** the command palette is open
- **WHEN** the user presses the Escape key
- **THEN** the command palette closes
- **AND** the palette is removed from the visible DOM

#### Scenario: Arrow keys navigate between palette options
- **GIVEN** the command palette is open with multiple options listed
- **WHEN** the user presses ArrowDown
- **THEN** the next option becomes selected with aria-selected true
- **AND** the previously selected option loses selection

#### Scenario: Arrow up returns to previous palette option
- **GIVEN** the second palette option is selected
- **WHEN** the user presses ArrowUp
- **THEN** the first option becomes selected again
- **AND** the second option loses selection

#### Scenario: First palette option is selected by default
- **GIVEN** the command palette just opened
- **WHEN** the user views the options list
- **THEN** the first option is marked as selected

#### Scenario: Topic search filters results as user types
- **GIVEN** the command palette is open with topics available
- **WHEN** the user types a partial topic name in the search input
- **THEN** only topics matching the search text are shown
- **AND** non-matching topics are hidden from the results

#### Scenario: Selecting a topic from palette navigates to it
- **GIVEN** the command palette shows filtered topic results
- **WHEN** the user clicks on a matching topic option
- **THEN** the palette closes
- **AND** the selected topic's content appears in the main area

#### Scenario: Theme toggle command changes document theme
- **GIVEN** the command palette is open showing available actions
- **WHEN** the user selects the theme toggle action
- **THEN** the palette closes
- **AND** the document theme class changes to reflect the new mode

#### Scenario: Theme cycles through light, dark, and system modes
- **GIVEN** the current theme is set to light mode
- **WHEN** the user executes the theme toggle action
- **THEN** the theme advances to dark mode
- **AND** the toggle action label updates to reflect the next available mode

#### Scenario: New chat command creates a new topic
- **GIVEN** the command palette is open
- **WHEN** the user selects the New Chat action
- **THEN** the palette closes
- **AND** a new empty chat pane opens with a start conversation prompt

#### Scenario: File search shows matching files from project
- **GIVEN** the command palette is open and a project with files is associated
- **WHEN** the user types a filename query
- **THEN** matching files appear in a FILES category section
- **AND** the results are displayed in the same listbox structure as other options

> Note: File search requires a focused topic with a projectPath set; test coverage uses route mocking for the file list API.

#### Scenario: File search works when project pane is focused
- **GIVEN** a project pane is focused and the palette is open
- **WHEN** the user types a file search query
- **THEN** the palette fetches the file list from the project files API
- **AND** matching files appear in the results

#### Scenario: Message search shows debounced results
- **GIVEN** the command palette is open
- **WHEN** the user types a search query of at least two characters
- **THEN** the palette waits for the debounce period before querying
- **AND** message results appear under a MESSAGES category header

#### Scenario: Message search results display role and content
- **GIVEN** message search results are returned from the search API
- **WHEN** the results are displayed in the palette
- **THEN** each result shows the message role prefix
- **AND** the message content snippet is visible

#### Scenario: Message search queries the search API endpoint
- **GIVEN** the user has typed a search query in the palette
- **WHEN** the debounce period elapses
- **THEN** a request is sent to the search API endpoint
- **AND** the response results are rendered in the palette

#### Scenario: Selecting a message result closes the palette
- **GIVEN** message search results are visible in the palette
- **WHEN** the user clicks on a message result
- **THEN** the palette closes
- **AND** the user is navigated to the relevant topic

#### Scenario: Open keyboard shortcuts modal
- **GIVEN** the application is loaded
- **WHEN** the user presses Cmd+/
- **THEN** the keyboard shortcuts modal opens
- **AND** a heading titled Keyboard Shortcuts is visible

#### Scenario: Keyboard shortcuts modal shows all shortcut groups
- **GIVEN** the keyboard shortcuts modal is open
- **WHEN** the user views the modal contents
- **THEN** group headings for General, Chat, and Voice are displayed
- **AND** at least one shortcut description appears under each group

#### Scenario: Keyboard shortcuts modal shows desktop-only shortcuts
- **GIVEN** the application is running in an Electron desktop context
- **WHEN** the user opens the keyboard shortcuts modal
- **THEN** desktop-specific shortcuts such as New Chat and Close Panel are visible

#### Scenario: Close keyboard shortcuts modal with toggle shortcut
- **GIVEN** the keyboard shortcuts modal is open
- **WHEN** the user presses Cmd+/ again
- **THEN** the modal closes
- **AND** the keyboard shortcuts heading is no longer visible

#### Scenario: Settings panel opens from sidebar menu
- **GIVEN** the sidebar is visible
- **WHEN** the user opens the settings from the sidebar menu
- **THEN** a settings panel appears as a modal overlay
- **AND** theme selection buttons for Light, Dark, and System are visible
- **AND** a font size control is visible
- **AND** message density options for Compact and Comfortable are visible

#### Scenario: Close settings panel via backdrop
- **GIVEN** the settings panel is open
- **WHEN** the user clicks outside the settings panel on the backdrop
- **THEN** the settings panel closes
- **AND** the main application is visible again

#### Scenario: Theme selection in settings persists across page reload
- **GIVEN** the settings panel is open
- **WHEN** the user selects the Dark theme button
- **THEN** the document theme class changes to dark
- **AND** after reloading the page the dark theme remains applied

#### Scenario: All settings values persist across page reload
- **GIVEN** the user has changed message density to Compact and font size to 16
- **WHEN** the user reloads the page and reopens settings
- **THEN** the Compact button appears with active styling
- **AND** the font size control shows 16

#### Scenario: Push notification toggle handles unsupported browser
- **GIVEN** the browser does not support push notifications
- **WHEN** the user opens the settings panel
- **THEN** the push notification section is either absent or shows a graceful fallback
- **AND** all other settings controls render correctly

#### Scenario: Push notification toggle shows denied state
- **GIVEN** the browser has denied notification permission
- **WHEN** the user opens the settings panel
- **THEN** the push notification area displays a blocked-by-browser message
- **AND** the user cannot enable push notifications

> Note: Push notification states depend on browser API support; Playwright Chromium may show different states.

#### Scenario: Palette search is debounced to avoid excessive queries
- **GIVEN** the command palette is open
- **WHEN** the user types rapidly in the search input
- **THEN** search API requests are not sent on every keystroke
- **AND** results appear only after the debounce period elapses

#### Scenario: Selecting a file from palette opens it in editor
- **GIVEN** file search results are visible in the command palette
- **WHEN** the user selects a file result
- **THEN** the palette closes
- **AND** the selected file opens in the file editor pane

> Note: File selection navigation depends on project pane routing; test coverage verifies the palette close mechanism.

#### Scenario: Category headers organize palette results by type
- **GIVEN** the command palette has results from multiple categories
- **WHEN** the user views the results list
- **THEN** category headers such as ACTIONS, TOPICS, FILES, and MESSAGES group the results
- **AND** each result appears under its appropriate category

### Requirement: CMD-06 — Every offered slash command has a destination

The composer's slash-command menu SHALL only offer commands that resolve
somewhere: either a client-side handler in the chat pane, or membership in the
server's `CLI_BUILTINS` allowlist, which delivers the message to the CLI
unmodified. A command in neither reaches the model as ordinary prose, carrying
the context preamble in front of it, and nothing happens.

Entries of the allowlist SHALL be matchable by the matcher that reads it:
lower-case, no slash, no whitespace.

> Written from the defect. On 2026-08-25 `/pause` ("Pause agent (@name)") and
> `/assign` ("Assign task (@name task)") were offered in the menu and existed
> nowhere — no handler, not allowlisted. Both were removed, and
> `client/src/components/Chat/slashCommandRouting.test.ts` now makes the class
> impossible rather than fixing the two instances.

#### Scenario: a command offered without a destination
- **GIVEN** an entry in the composer's `SLASH_COMMANDS` list
- **WHEN** it is neither handled in the chat pane nor present in `CLI_BUILTINS`
- **THEN** the check fails and names it

#### Scenario: a command that relies only on the allowlist
- **GIVEN** an offered command with no client-side handler (`/compact`, `/clear`, `/model`, `/status`, `/context`, `/help`)
- **THEN** it is present in `CLI_BUILTINS`
- **AND** removing it from that list fails the check, because it would silently become prose

#### Scenario: the help text and the menu cannot disagree
- **GIVEN** `/help`, which is the one place a user asks what can be typed here
- **THEN** its text is DERIVED from the same array the menu is built from
- **AND** a hand-written second list fails the check, because two hand-kept lists drift and neither looks incomplete on its own

#### Scenario: a command the CLI cannot run in this mode
- **GIVEN** a command the CLI's own registry marks `supportsNonInteractive: false` (a TUI screen), such as `/rewind`
- **WHEN** it is typed in the chat, where the CLI runs with `--print`
- **THEN** it is answered locally, saying so and naming what to use instead
- **AND** it is NOT forwarded to a process that discards it without a word

#### Scenario: an allowlist entry that can never match
- **GIVEN** an entry written with a leading slash, whitespace or an upper-case letter
- **WHEN** the matcher compares the first token of a message against the list
- **THEN** that entry can never match, and the check fails instead of leaving it there reading as coverage

### Requirement: CMD-07 — `/status` answers the question that made someone type it

`/status` SHALL report the facts that decide how the next turn behaves — the
model and where it comes from, the reasoning effort, fast mode, the autonomy
level and what that level means, and whether the MCP fleet is the reduced
bridge — and SHALL NOT spend lines on what the user can already read off the
screen.

A field with no value SHALL produce no line: an absent override IS the default,
and a line saying "none" pushes the lines that matter further down.

> Written from the gap. The previous report named four things — session key,
> message count, project path, topic name — three of which are already visible
> (tab, sidebar) and one of which is an internal identifier. Everything that
> explains a surprise was missing, from the same `topic` object the handler
> already held.

#### Scenario: the turn refused to touch files
- **GIVEN** a topic whose autonomy level is `ask`
- **WHEN** the user asks for the session status
- **THEN** the report names the level AND what it means ("touches no file, runs no command")
- **AND** an unrecognised level says so, instead of printing a mute line

#### Scenario: the model is pinned, or it is not
- **GIVEN** a topic that pins a model
- **THEN** the report names it and says it is pinned on this topic
- **GIVEN** a topic that pins none
- **THEN** the report names the model that would serve the next turn and says it is a default
- **AND** the pinned case does not also print the fallback: two "model" lines are two answers to one question

#### Scenario: a capability is missing rather than a behaviour surprising
- **GIVEN** a topic whose MCP policy is `bridge-only`
- **THEN** the report says the fleet is reduced to the `topics` bridge
- **AND** the full fleet, being the default, produces no line

#### Scenario: nothing to say is said with silence
- **GIVEN** a topic with no effort override, fast mode off, no worktree and no context files
- **THEN** none of those produce a line
- **AND** the internal session identifier is last, because it is copied into a bug report rather than read

#### Scenario: a session the registry does not know
- **GIVEN** a session key with no topic behind it
- **THEN** the report still answers, with the facts it does have, instead of failing the command

### Requirement: CMD-02 — Push Notifications

The system SHALL support browser push notification subscription management with VAPID key exchange, subscribe and unsubscribe flows, permission state handling, and graceful degradation for unsupported browsers.

#### Scenario: Unsupported browser sets state to unsupported
- **GIVEN** the browser does not support ServiceWorker or PushManager APIs
- **WHEN** the push notifications hook initializes
- **THEN** the push state is set to "unsupported"
- **AND** subscribe and unsubscribe actions are effectively no-ops

#### Scenario: Denied permission sets state to denied
- **GIVEN** the browser supports push notifications
- **WHEN** the Notification.permission is "denied"
- **THEN** the push state is set to "denied"
- **AND** calling subscribe has no effect

#### Scenario: Default permission with no subscription sets state to default
- **GIVEN** the browser supports push notifications
- **WHEN** the notification permission is "default" and no existing subscription exists
- **THEN** the push state is set to "default"

#### Scenario: Existing subscription sets state to subscribed
- **GIVEN** the browser supports push notifications and permission is granted
- **WHEN** an existing push subscription is found via PushManager
- **THEN** the push state is set to "subscribed"

#### Scenario: Subscribe requests notification permission
- **GIVEN** the push state is "default"
- **WHEN** the user triggers the subscribe action
- **THEN** the browser permission prompt is displayed via Notification.requestPermission
- **AND** a loading state is set to true during the process

#### Scenario: Subscribe fetches VAPID public key from server
- **GIVEN** the user grants notification permission
- **WHEN** the subscribe flow continues
- **THEN** a request is made to /api/push/vapid-public-key to retrieve the server public key
- **AND** the key is converted to a Uint8Array for PushManager subscription

#### Scenario: Subscribe registers subscription with server
- **GIVEN** the VAPID key has been retrieved and a PushManager subscription is created
- **WHEN** the subscription object is ready
- **THEN** a POST request is sent to /api/push/subscribe with the subscription JSON
- **AND** the push state changes to "subscribed"

#### Scenario: Subscribe sets denied state when permission refused
- **GIVEN** the push state is "default"
- **WHEN** the user denies the notification permission prompt
- **THEN** the push state changes to "denied"
- **AND** the loading state returns to false

#### Scenario: Unsubscribe removes subscription from browser and server
- **GIVEN** the push state is "subscribed"
- **WHEN** the user triggers the unsubscribe action
- **THEN** a POST request is sent to /api/push/unsubscribe with the subscription endpoint
- **AND** the browser PushManager subscription is unsubscribed
- **AND** the push state changes to "default"

#### Scenario: Unsubscribe shows loading state during process
- **GIVEN** the user triggers unsubscribe
- **WHEN** the unsubscription is in progress
- **THEN** the loading flag is set to true
- **AND** loading returns to false once the process completes

#### Scenario: Subscribe error is logged without crashing
- **GIVEN** the subscribe flow encounters a network or API error
- **WHEN** the error occurs during VAPID key fetch or subscription registration
- **THEN** the error is logged to the console
- **AND** the loading state returns to false
- **AND** the push state does not change to "subscribed"

### Requirement: CMD-03 — Reopen most recently closed tab

The system SHALL reopen the most recently closed tab on a keyboard chord,
resolving the target synchronously from the in-memory recently-closed stack
(`closedStack`, newest-first) so the action is instant for non-terminal panes.
The primary chord SHALL be `⇧⌘T` (Shift+Cmd/Ctrl+T); `⌘⇧U` SHALL remain a
working alias for backwards compatibility. Both chords SHALL call
`preventDefault()`.

Terminal panes whose underlying session has died SHALL be recreated via
`POST /api/terminal/sessions` (idempotent by paneId+closedAt) as part of reopen;
all other pane types SHALL be restored from the captured record without a network
round-trip.

#### Scenario: Reopen with ⇧⌘T

- **GIVEN** the user has just closed a chat tab
- **WHEN** the user presses `⇧⌘T`
- **THEN** the closed tab is reopened and focused
- **AND** the record is removed from the recently-closed stack

#### Scenario: ⌘⇧U remains a working alias

- **GIVEN** the user has just closed a tab
- **WHEN** the user presses `⌘⇧U`
- **THEN** the same reopen behavior occurs as for `⇧⌘T`

#### Scenario: Reopen is a no-op with an empty stack

- **GIVEN** no tab has been closed (the recently-closed stack is empty)
- **WHEN** the user presses `⇧⌘T`
- **THEN** nothing is reopened and no error is raised

#### Scenario: Electron menu triggers reopen

- **GIVEN** the app is running under Electron
- **WHEN** the user invokes View → "Reopen Closed Tab" (accelerator `CmdOrCtrl+Shift+T`)
- **THEN** the main process sends a `reopen-closed-tab` IPC message
- **AND** the renderer reopens the most recently closed tab via the same entry point used by the keyboard chord

> Note: `b43d02b4` — the Electron menu accelerator yields to the renderer chord and the shared handler is idempotency-guarded, so `⇧⌘T` reopens exactly one tab under Electron.

### Requirement: CMD-04 — Single reopen entry point shared by all surfaces

Every user-facing surface that reopens a closed tab — the keyboard chords
(`⇧⌘T` / `⌘⇧U`), the command palette "recently closed" list (`⌘K`), and the
Electron menu — SHALL funnel through the same `handleReopenClosedTab(record)`
callback. No surface SHALL implement an independent reopen path.

#### Scenario: Command palette reopen uses the shared entry point

- **GIVEN** the command palette is open showing the "Chiuse di recente" list
- **WHEN** the user selects a recently-closed entry
- **THEN** the tab is reopened via `handleReopenClosedTab`
- **AND** the palette closes

#### Scenario: Project-inner tabs are restored by their owning window

- **GIVEN** a recently-closed record whose `level` is `project`
- **WHEN** reopen is invoked from any surface
- **THEN** a cancelable `reopen-closed-tab` event is dispatched and claimed by the
  owning project window, which restores the pane into its original group
- **AND** the record is consumed off the stack only after the window claims it

### Requirement: CMD-05 — Recently-closed history is durable and bounded

The recently-closed stack SHALL persist across page reloads and app restarts
(via the synced `pane-store-v2` snapshot) and SHALL be bounded FIFO at
`CLOSED_STACK_MAX` (50). Reopening or clearing a record SHALL remove it from the
stack. Pane id remaps (draft→real promotion, terminal session recreation) SHALL
rewrite matching ids inside the stack records, including `tabOrderSnapshot`.

#### Scenario: History survives reload

- **GIVEN** the user closed several tabs
- **WHEN** the page is reloaded
- **THEN** the "recently closed" list in `⌘K` still lists those tabs (up to 50)

#### Scenario: Stack is bounded FIFO at 50

- **GIVEN** more than 50 tabs have been closed in sequence
- **THEN** the stack retains only the 50 most recent records, dropping the oldest

#### Scenario: Pane id remap rewrites stack records

- **GIVEN** a recently-closed record references pane id `A`
- **WHEN** a `PANE_ID_REMAP` from `A` to `B` is dispatched
- **THEN** the record's id and any `tabOrderSnapshot` entry equal to `A` become `B`


### Requirement: SKILL-01 — The user's own commands and skills are discovered from known folders

The system SHALL offer, alongside the built-in slash commands, the commands and
skills the user authored on disk: `<name>.md` files under the command folders
(the user's home folder first, then the project's), and `<name>/SKILL.md`
directories under the skill folders. Each entry SHALL declare which of the two it
is, so the interface can tell a command from a skill. A name SHALL appear once
even when several folders hold it, and a folder that does not exist SHALL be
skipped rather than failing the listing.

#### Scenario: Commands and skills are listed together, each declaring its kind
- **GIVEN** a command in the user's folder, a command in the project's folder, and a skill directory
- **WHEN** the available commands are listed
- **THEN** all three SHALL be present
- **AND** the skill SHALL be declared a skill, not a command

#### Scenario: A name appears once
- **GIVEN** the same name present in more than one folder
- **WHEN** the list is built
- **THEN** it SHALL appear exactly once

#### Scenario: The HTTP listing declares the kind of every entry
- **GIVEN** the slash-command listing endpoint
- **WHEN** it is called
- **THEN** it SHALL answer with a list
- **AND** every entry SHALL carry a name and a kind that is either command or skill

### Requirement: SKILL-02 — A command's body is read from disk behind a path-containment gate

The system SHALL be able to show the BODY of an invoked command, read from the
file it lives in. The name arrives from the client, so it SHALL be admitted only
when made of letters, digits, `-`, `_` and `:`, starting with a letter and no
longer than 128 characters; and the RESOLVED path SHALL be verified to fall
inside one of the known folders AFTER resolution, so a symlink cannot lead out.
The body SHALL be truncated at a size limit rather than loading an arbitrarily
large file.

#### Scenario: Real names pass and everything that could escape does not
- **GIVEN** names such as `recap`, `opsx:propose` and `jarvis-custom-skills:master`
- **WHEN** they are validated
- **THEN** they SHALL be admitted
- **AND** a name containing `..`, a slash, a backslash, a space, a leading digit, or one absurdly long SHALL be refused

#### Scenario: An existing command's body is read
- **GIVEN** a command file in the user's folder, a project command, and a skill directory
- **WHEN** each is resolved by name
- **THEN** the body SHALL be the file's content
- **AND** the kind SHALL say whether it came from a command file or a skill directory

#### Scenario: A traversal name reads nothing
- **GIVEN** names shaped like `../../../etc/passwd` or `a/../../b`
- **WHEN** they are resolved
- **THEN** nothing SHALL be returned

#### Scenario: A symlink pointing outside is not followed
- **GIVEN** a file with an admitted name, inside a known folder, that is a link to a file outside every known folder
- **WHEN** it is resolved
- **THEN** nothing SHALL be returned, even though the NAME was admissible

#### Scenario: The body is truncated instead of loaded whole
- **GIVEN** a command file larger than the configured limit
- **WHEN** its body is read
- **THEN** the returned body SHALL be exactly the limit in length

#### Scenario: The route asks the gate before touching the disk
- **GIVEN** encoded escape shapes that survive URL normalisation (`..%2F..%2F`, `%2e%2e%2f`, `%2Fetc%2F`, a NUL byte)
- **WHEN** each is requested through the command-source endpoint
- **THEN** every one SHALL be refused with a client error
- **AND** a well-formed name that simply does not exist SHALL answer not-found instead, so the refusal is the gate's judgement and not a blanket denial

### Requirement: SKILL-03 — A message that IS a slash invocation is recognised, and nothing else is

Since the CLI expands a slash command BEFORE the turn — nothing on the wire says
a command ran — the user's own message is the only honest record of it. The
system SHALL recognise a single-line message that begins with a slash followed by
a plausible command name, with optional arguments, as an invocation, and SHALL
recognise nothing else as one: mislabelling an ordinary message is worse than
labelling none.

#### Scenario: A bare command, and a command with arguments
- **GIVEN** the messages `/recap`, `  /vai  ` and `/vai solo il bug X`
- **WHEN** they are parsed
- **THEN** the first two SHALL yield the command with no arguments
- **AND** the third SHALL yield the command with its arguments separated

#### Scenario: Marketplace names with colons and dashes are commands
- **GIVEN** `/jarvis-custom-skills:master` and `/opsx:propose`
- **WHEN** they are parsed
- **THEN** each SHALL yield its full name as the command

#### Scenario: A path is not a command
- **GIVEN** a message that is a filesystem path beginning with a slash
- **WHEN** it is parsed
- **THEN** it SHALL NOT be treated as an invocation

#### Scenario: Prose beginning with a slash is not a command
- **GIVEN** messages such as `/ ciao`, `//commento` and `/2 volte`
- **WHEN** they are parsed
- **THEN** none SHALL be treated as an invocation

#### Scenario: More than one line is a message, not a command
- **GIVEN** a message whose first line is a command and which continues on another line
- **WHEN** it is parsed
- **THEN** it SHALL NOT be treated as an invocation

#### Scenario: Empty and non-string input do not throw
- **GIVEN** an empty string, or a value that is not a string
- **WHEN** it is parsed
- **THEN** the result SHALL be no invocation, and nothing SHALL be thrown

### Requirement: SKILL-04 — The message that ran a command reads as a command, once, and opens its body

Since the CLI expands a slash command before the turn, the user's own message
SHALL be the single place the transcript shows that a command ran: it SHALL
render as the command it invoked, and there SHALL NOT be a second marker on the
same turn saying the same thing. Expanding it SHALL show the body of the command
FILE, fetched on demand rather than carried by the turn, with no redundant label
repeating what the header already says. A message that merely begins with a slash
without being a command SHALL render no such marker.

#### Scenario: The user's message renders as the command it ran
- **GIVEN** a turn whose user message is `/recap`, with a `recap.md` present in the server's command folder
- **WHEN** the topic is opened
- **THEN** the message SHALL render as an invocation naming that command

#### Scenario: One marker per turn, not two
- **GIVEN** the same turn
- **WHEN** its markers are counted within that turn
- **THEN** there SHALL be exactly one
- **AND** the separate "this turn runs /x" row SHALL NOT be present anywhere

#### Scenario: Expanding shows the body of the real file
- **GIVEN** the command file seeded in the folder the server actually reads
- **WHEN** the marker is expanded
- **THEN** the file's content SHALL appear
- **AND** no label repeating "command" or "skill" SHALL sit above it

#### Scenario: A path renders no marker
- **GIVEN** a user message that is a filesystem path beginning with a slash
- **WHEN** the topic is opened
- **THEN** that message SHALL carry no invocation marker

### Requirement: TOOL-PARITY-01 — Ogni tool che la CLI emette ha una riga leggibile

Topics rende le chiamate a tool di Claude Code, Codex e OpenClaw traducendole in
un `ToolCallDetail` tipizzato. Quando un nome non corrisponde a nessun tipo noto
il sistema NON DEVE perdere la chiamata: risponde `type: "unknown"` e il
renderer mostra un JSON generico. Quel ripiego è corretto come rete di
sicurezza, e **inaccettabile come stato stabile** per un tool che la CLI emette
di continuo: chi legge la chat vede un blocco di JSON dove dovrebbe vedere
un'azione.

Il sistema DEVE quindi mantenere un **inventario dichiarato** dei nomi che la
CLI emette davvero, diviso in due:

1. i nomi **resi**, che DEVONO tradursi in un tipo diverso da `unknown`;
2. i nomi **a debito**, ancora resi come JSON grezzo perché richiedono un tipo
   nuovo e una riga nel renderer.

La lista a debito DEVE essere auto-pulente: quando una sua voce comincia a
rendersi, il controllo DEVE diventare rosso e obbligare a toglierla. Una lista
di eccezioni che non si accorge di essere stale è il modo in cui una copertura
finta sopravvive per mesi.

Alias dello stesso tool DEVONO rendersi allo stesso modo. `Agent` e `Task` sono
la stessa operazione sotto due nomi.

Il mirror sul client (`client/src/components/Chat/toolDetail.ts`), che serve i
messaggi vecchi il cui `detail` non fu costruito lato server, DEVE conoscere gli
stessi nomi del server: i due percorsi non si incontrano mai a runtime, quindi
una divergenza non si manifesta come errore ma come due rese diverse per la
stessa cosa.

> Nota sull'inventario: non si scrive a memoria. I nomi si leggono dai
> transcript veri (`~/.claude/projects/**/*.jsonl`, blocchi `tool_use`). La
> prima misura, 25/08/2026 su 40 sessioni, ha trovato 34 nomi distinti e
> **10 su 28 non resi**, fra cui `Agent` con 58 occorrenze reali mentre `Task`
> — lo stesso tool sotto il nome vecchio — si rendeva correttamente.

#### Scenario: un tool reso smette di rendersi

- **GIVEN** un nome nell'inventario dei tool resi
- **WHEN** la sua traduzione torna `type: "unknown"`
- **THEN** il controllo è rosso: è una regressione di parità

#### Scenario: un tool a debito comincia a rendersi

- **GIVEN** un nome nella lista a debito
- **WHEN** la sua traduzione non è più `unknown`
- **THEN** il controllo è rosso e chiede di toglierlo dalla lista

#### Scenario: due nomi dello stesso tool divergono

- **GIVEN** `Agent` e `Task`
- **WHEN** le loro traduzioni danno tipi diversi
- **THEN** il controllo è rosso

#### Scenario: il mirror del client resta indietro

- **GIVEN** un alias riconosciuto dal server
- **WHEN** il mirror sul client non lo nomina
- **THEN** il controllo è rosso

### Requirement: WEB-01 — Le chiamate web hanno una riga leggibile, e le due non si confondono

Claude Code ha due strumenti che escono verso la rete, `WebSearch` e `WebFetch`,
e in Topics sono la superficie che risponde a «cosa ha guardato fuori». Fino al
25/08/2026 erano rese e coperte da test, e **nessun requisito le nominava**.

Il sistema DEVE renderle come **due righe diverse**, perché rispondono a due
domande diverse:

1. `WebSearch` è una **ricerca**: si mostra come una riga di ricerca che dichiara
   la propria origine (`toolName: 'web_search'`), accanto a `grep` e `glob`, e
   porta la query. Chi rilegge deve poter distinguere una ricerca sul disco da
   una ricerca sulla rete: sono la stessa forma di gesto con implicazioni di
   privacy opposte.
2. `WebFetch` è un **prelievo**: porta l'URL, la domanda posta alla pagina e ciò
   che è tornato. L'URL è la parte che chi legge vuole poter aprire.

Un errore di mappatura fra le due NON DEVE poter passare inosservato: le
asserzioni che le verificano DEVONO fallire quando la traduzione cambia tipo.

> Nota, e non è un dettaglio di stile. Prima del 25/08/2026 il test di
> `WebSearch` aveva questa forma:
>
> ```ts
> const d = deriveToolDetail("WebSearch", { query: "..." });
> if (d.type === "search") { expect(d.toolName).toBe("web_search"); }
> ```
>
> Se la mappatura si fosse rotta, `d.type` non sarebbe stato `"search"`, il
> blocco non sarebbe entrato e **il test sarebbe rimasto verde**. La stessa
> forma è stata trovata in **nove** test dello stesso file: nove asserzioni che
> non potevano fallire. Adesso ognuno dichiara il tipo PRIMA di restringerlo, e
> rompendo la mappatura di `websearch` due test diventano rossi — misurato.

#### Scenario: una ricerca sulla rete si distingue da una sul disco

- **GIVEN** una chiamata `WebSearch`
- **WHEN** viene tradotta
- **THEN** è una riga di ricerca che dichiara `web_search` come origine
- **AND** porta la query

#### Scenario: un prelievo porta l'indirizzo

- **GIVEN** una chiamata `WebFetch` con url, prompt e risultato
- **WHEN** viene tradotta
- **THEN** è una riga di prelievo che porta tutti e tre

#### Scenario: una mappatura rotta non passa in silenzio

- **GIVEN** la traduzione di `websearch` viene cambiata perché non corrisponda più
- **WHEN** la suite gira
- **THEN** almeno un test diventa rosso

### Requirement: CMD-08 — Un comando si instrada sul provider DICHIARATO, non su quello risolto

Uno slash command che si biforca sul provider — il modello, lo sforzo di
ragionamento — SHALL essere instradato in base al provider che il topic
DICHIARA, e NON in base a quello che il registro riesce a risolvere su questa
macchina.

I due non sono la stessa cosa, e la differenza è un difetto già pagato. Chi
risolve un provider deve pur restituire un oggetto con cui parlare, quindi
quando il nome dichiarato non è registrato ripiega sul default. Su una macchina
senza la riga di comando di quel provider il ripiego cambia la natura del topic:
un comando su un topic dichiarato per un fornitore partiva verso il ponte di un
altro, che lì non esiste, e rispondeva con un errore di connessione. La stessa
prova era VERDE in locale, dove il binario c'è, e ROSSA altrove — per sei
giorni. **Un topic non cambia natura perché su questa macchina manca un
binario.**

Un topic che non dichiara nulla SHALL ereditare il default del server. Senza
dichiarazione E senza default il sistema NON SHALL inventare una rotta.

Una dichiarazione vuota o fatta di soli spazi SHALL valere come «non
dichiarato», e l'assenza SHALL restare assenza — mai una stringa vuota che si
comporta come un nome.

I nomi storici di un provider SHALL essere ricondotti al nome corrente nello
stesso punto in cui li riconduce la risoluzione, o le due strade divergono
proprio sui topic più vecchi.

La regola SHALL essere PURA e provata a parte: il ripiego che la rompeva è
esattamente il genere di cosa che un blocco di cattura silenzioso fa sparire
senza lasciare traccia.

#### Scenario: la macchina non ha quel binario
- **GIVEN** un topic che dichiara un provider non registrato qui, e un default diverso
- **THEN** il comando NON SHALL essere instradato verso il default

#### Scenario: nessuna dichiarazione, nessun default
- **GIVEN** un topic senza provider e un server senza default
- **THEN** NON SHALL essere scelta nessuna rotta

### Requirement: CMD-09 — Svuotare la conversazione usa il gesto che quel fornitore CAPISCE

Il gesto per svuotare la conversazione SHALL essere scelto in base a ciò che il
fornitore sa fare: dimenticare la sessione dove esiste, mandare il comando DENTRO
la sessione dove è quello il canale, e NON FARE NIENTE — dichiarandolo — dove non
esiste nessuno dei due.

Chiamare in modo opzionale un metodo che un fornitore non implementa NON produce
nessun errore e nessuna traccia: la chat si svuota a schermo e il modello ricorda
tutto.

Con ENTRAMBE le possibilità SHALL vincere il dimenticare la sessione.

La scelta SHALL essere verificata sui fornitori VERI, non su oggetti finti che
dichiarano quel che si vuole.

#### Scenario: un fornitore che non implementa nessuno dei due
- **GIVEN** nessun canale disponibile
- **THEN** SHALL essere dichiarato che non si può fare niente

#### Scenario: i fornitori veri
- **GIVEN** le implementazioni reali
- **THEN** ognuna SHALL cadere nel ramo giusto

### Requirement: MISSION-01 — Una missione dice COME si sa che è finita, e sa a chi va

Ogni missione preconfezionata SHALL dichiarare COME si riconosce che è finita: è
esattamente ciò che la distingue da un prompt.

Quella barra SHALL finire NEL testo che arriva alla sessione, non soltanto nella
voce di menu: una barra che resta nel menu non è una barra.

Gli identificativi delle missioni SHALL essere UNICI: il menu ci costruisce la
chiave di lista.

Il bersaglio SHALL essere scelto così: la chat a FUOCO vince; MAI una sessione
altrui; senza chat aperte, la chat del progetto toccata più di recente.

Senza nessun bersaglio SHALL essere restituito NIENTE, e chi chiama SHALL dirlo —
non inventarsi una sessione.

#### Scenario: nessuna chat aperta
- **GIVEN** nessuna chat a fuoco
- **THEN** SHALL essere scelta la chat del progetto toccata più di recente

#### Scenario: nessun bersaglio
- **GIVEN** nessuna sessione candidabile
- **THEN** NON SHALL essere inventata nessuna sessione

### Requirement: CTRLTOOL-01 — Gli strumenti di controllo hanno un vocabolario CHIUSO, e ogni rifiuto ha il suo nome

Gli strumenti di controllo esposti SHALL essere ESATTAMENTE quelli dichiarati,
ciascuno con i propri argomenti obbligatori, e il riconoscimento SHALL rifiutare
qualunque altro nome. Uno strumento sconosciuto SHALL sollevare un errore con il
proprio CODICE.

Il cambio di argomento SHALL annunciare il passaggio per un bersaglio esistente e
non archiviato. Un bersaglio ARCHIVIATO SHALL sollevare «archiviato» e NON «non
trovato» — e NON SHALL annunciare niente: sono due situazioni diverse e chi legge
il messaggio va a cercare due cose diverse. Un bersaglio MANCANTE SHALL sollevare
«non trovato», e un identificativo assente SHALL sollevare «argomenti sbagliati».

La creazione di un argomento SHALL EREDITARE il percorso del progetto e
annunciare prima la creazione e poi il passaggio.

La creazione di un progetto SHALL impalcare la cartella e il file di contesto,
legare, e annunciare. Una COLLISIONE SHALL sollevare «progetto esistente» —
NESSUNA sovrascrittura, NESSUN legame, NESSUN annuncio. Un nome vuoto dopo la
pulizia SHALL sollevare «argomenti sbagliati».

L'apertura di un progetto SHALL risolvere per NOME dentro lo spazio di lavoro
noto, legare e annunciare; SHALL sollevare «non trovato» sia per un riferimento
sconosciuto SIA per un percorso ASSOLUTO, perché i percorsi grezzi non sono
fidati.

La risoluzione di una tab SHALL restituire il risultato VERBATIM, senza NESSUN
effetto collaterale; un riferimento che non è un permalink SHALL avere la propria
risposta; un riferimento vuoto SHALL sollevare «argomenti sbagliati» SENZA
chiamare il risolutore; e senza risolutore iniettato SHALL DIRLO.

#### Scenario: un bersaglio archiviato
- **GIVEN** un argomento archiviato
- **THEN** SHALL sollevare «archiviato», senza annunciare niente

#### Scenario: un percorso assoluto come riferimento di progetto
- **GIVEN** un percorso invece di un nome
- **THEN** SHALL sollevare «non trovato»

### Requirement: MCPSRV-01 — Il server degli strumenti regge il protocollo VERO, come processo separato

Le prove sulle funzioni esportate non toccano il processo. Questo SHALL accendere
il server come SOTTOPROCESSO vero e parlargli con il protocollo di chiamata sul
suo ingresso e uscita standard, esattamente come fa la riga di comando.

La stretta di mano iniziale SHALL funzionare, e l'elenco degli strumenti SHALL
restituirli tutti.

Le chiamate SHALL fare il giro completo verso le porte della sessione: l'elenco
dei processi, l'esecuzione di uno script che passa il nome, e la risoluzione di
una tab che interroga la porta dedicata e restituisce ciò che ha risolto.

Uno strumento SCONOSCIUTO SHALL tornare un errore di protocollo, non un silenzio.

#### Scenario: uno strumento sconosciuto
- **GIVEN** una chiamata a un nome inesistente
- **THEN** SHALL tornare un errore di protocollo

### Requirement: MCPSRV-02 — I server MCP configurati valgono per OGNI runtime, e un'assenza si spiega

Gli strumenti esterni configurati una volta SHALL essere montati da qualunque
runtime chieda il proprio registro, non solo da quello che li aveva per primo:
finche' il montaggio e' vissuto sul solo ramo della riga di comando, i server
venivano risolti e poi letti da nessuno — il registro del runtime nativo non
conteneva NIENTE col prefisso degli strumenti esterni.

Quando un server configurato NON c'e', il sistema SHALL dire perche'. Uno
strumento che manca senza spiegazione e' indistinguibile da un difetto, e la
ragione non SHALL restare su una riga di diagnostica che nessuno legge.

La prova di questo requisito SHALL parlare il protocollo VERO su entrambi i
trasporti supportati, invece di sostituire il server con un finto: cio' che
deve reggere e' la stretta di mano e la chiamata.

#### Scenario: il runtime nativo monta i server configurati
- **GIVEN** una configurazione con un server MCP funzionante
- **WHEN** il runtime nativo chiede il proprio registro di strumenti
- **THEN** il registro SHALL contenere gli strumenti di quel server

#### Scenario: un server assente porta con se' la sua ragione
- **GIVEN** un server configurato che non viene montato
- **THEN** il motivo SHALL essere esposto insieme all'assenza

### Requirement: MCPSRV-03 — La lista degli strumenti di un server e' viva, non la fotografia del montaggio

Un server MCP puo' guadagnare strumenti mentre il processo vive: e' esattamente
cio' che fa un gateway quando monta un figlio su richiesta dell'agente. La
flotta li elencava una volta sola al montaggio, quindi lo strumento nuovo
restava irraggiungibile e l'agente che lo chiamava leggeva «unknown MCP tool»
per uno strumento che il server offriva davvero.

Un server che dichiara `tools.listChanged` SHALL essere ri-elencato dopo ogni
chiamata RIUSCITA a un suo strumento, da solo: senza chiudere connessioni,
senza rimontare la flotta e senza toccare gli altri server. Il predicato SHALL
essere la dichiarazione del server, non un elenco di nomi di strumenti che
montano: un elenco del genere marcisce al primo strumento nuovo.

Il ri-elenco SHALL essere concluso prima che la chiamata restituisca il suo
risultato. La garanzia da dare e' che quando lo strumento che monta RITORNA, i
suoi strumenti nuovi sono gia' richiamabili: un agente dispacciato ha un turno
solo, e fra «deterministico» e «prima o poi» passa la differenza fra funziona e
non funziona.

Il registro offerto al modello SHALL essere quello del giro, non quello
dell'inizio del turno, altrimenti lo strumento comparso viene visto solo dal
turno dopo.

Gli schemi consegnati all'API SHALL essere copie. I punti di interruzione della
cache si scrivono IN PLACE sull'ultimo strumento dell'array; con una lista che
puo' crescere a meta' turno i marcatori si accumulano sugli schemi memorizzati
fino a superare il tetto, e l'API rifiuta il turno intero. L'ordine SHALL essere
stabile per nome, perche' cancellare e reinserire le voci di un server le
sposta in fondo e cambia l'array serializzato anche quando l'insieme e'
identico, invalidando il prefisso cachato senza che nessuno abbia guadagnato
niente.

#### Scenario: uno strumento che monta un figlio lo rende chiamabile subito
- **GIVEN** un server che dichiara `tools.listChanged` e uno strumento che ne fa comparire un altro
- **WHEN** l'agente chiama quello strumento
- **THEN** lo strumento comparso SHALL essere richiamabile senza rimontare la flotta

#### Scenario: il ri-elenco costa una chiamata sola, e solo a chi lo dichiara
- **GIVEN** un server che dichiara `tools.listChanged` e uno che non lo dichiara
- **WHEN** si chiama uno strumento per ciascuno
- **THEN** SHALL essere ri-elencato solo il primo

#### Scenario: gli schemi consegnati al modello non tornano marchiati
- **GIVEN** un registro gia' consegnato una volta e marcato per la cache
- **WHEN** lo si richiede di nuovo
- **THEN** nessuno schema SHALL portare il marcatore della lettura precedente

### Requirement: CMD-COMMA-01 — La scorciatoia delle Impostazioni cede solo a chi POSSIEDE il tasto

`⌘,` e `Ctrl+,` SHALL aprire le Impostazioni. La palette dei comandi lo
annunciava accanto a «Settings» da prima che qualcuno lo ascoltasse.

Il gestore SHALL cedere il passo SOLO alle superfici che possiedono davvero la
combinazione grezza — un terminale xterm e un editor CodeMirror — e NON a
qualunque campo di testo a fuoco. La differenza non e' stilistica: `isMod` e'
`metaKey || ctrlKey`, e su Windows `Ctrl` e' l'UNICA via perche' `metaKey` li' e'
sempre falso. Una guardia che cede a ogni input rende quindi la scorciatoia muta
esattamente dove si vive, nel composer della chat.

La ragione di cedere resta vera ma e' piu' stretta della guardia che c'era:
dentro xterm e CodeMirror `Ctrl+,` e' un tasto VERO, e questo gestore corre in
fase di CATTURA su `window`, quindi il suo `preventDefault()` se lo mangerebbe
prima che la superficie lo veda. Una `textarea` con `Ctrl+,` non ci fa niente:
non c'e' niente a cui cedere.

#### Scenario: si scrive nel composer
- **GIVEN** il fuoco nel composer della chat
- **WHEN** si preme `Ctrl+,`
- **THEN** le Impostazioni SHALL aprirsi

#### Scenario: il fuoco e' in un terminale
- **GIVEN** un terminale xterm che possiede la tastiera
- **WHEN** si preme `Ctrl+,`
- **THEN** le Impostazioni NON SHALL aprirsi
- **AND** il tasto SHALL arrivare al terminale

### Requirement: CMD-COMMA-02 — `⌘,` resta assoluto sul Mac

Sul Mac `⌘,` e' una convenzione di sistema e SHALL funzionare anche mentre si
scrive, terminale compreso: li' non si cede a nessuno. La distinzione e' fra i
due modificatori, non fra le due piattaforme — `metaKey` non cede mai, `Ctrl`
cede alle due superfici di CMD-COMMA-01.

#### Scenario: il fuoco e' in un terminale, su Mac
- **GIVEN** un terminale xterm che possiede la tastiera
- **WHEN** si preme `⌘,`
- **THEN** le Impostazioni SHALL aprirsi lo stesso

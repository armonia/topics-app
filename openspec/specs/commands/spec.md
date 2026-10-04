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

#### Scenario: A chat updated in the background does not move the results
- **GIVEN** the palette shows the results of a query, scrolled by finger with the first row selected
- **WHEN** a listed chat is updated in the background (a rename, the end of a turn)
- **THEN** the rows keep the order they had for that query, the updated row changing in place, and the list stays where the finger left it
- **AND** the selected row is still the chat Enter opened before, and the message search is not sent again

### Requirement: CMD-06 — Every offered slash command has a destination

The composer's slash-command menu SHALL only offer commands that resolve
somewhere: a branch of the chat pane that runs it or opens a control, a name
the session's own engine lists as runnable in the mode Topics drives it
(CMDUI-01), which is then delivered unmodified, or, on Topics' native engine, a
skill its prompt lists. A command in none of these reaches the model as ordinary
prose, and nothing happens.

Being in the server's `CLI_BUILTINS` allowlist is NOT a destination by itself: a
name the CLI refuses in `--print` (`isn't available in this environment`) SHALL be
answered locally, and a name the CLI does not have SHALL NOT be in the list. A name
the CLI accepts only as an alias of another (`review` of `code-review`, `cost` of
`usage`) is not in the CLI's list and SHALL count as its canonical name.

Entries of the allowlist SHALL be matchable by the matcher that reads it:
lower-case, no slash, no whitespace.

> Written from the defect. On 2026-08-25 `/pause` ("Pause agent (@name)") and
> `/assign` ("Assign task (@name task)") were offered in the menu and existed
> nowhere — no handler, not allowlisted. Both were removed, and
> `client/src/components/Chat/slashCommandRouting.test.ts` now makes the class
> impossible rather than fixing the two instances. On 2026-10-03 `/resume` was
> found offered AND allowlisted, and refused by the CLI on every turn: membership
> in the allowlist had been read as a destination.

#### Scenario: a command offered without a destination
- **GIVEN** an entry the menu offers
- **WHEN** it is neither handled in the chat pane, nor in the engine's own list of runnable commands, nor a skill the native engine lists
- **THEN** the check fails and names it

#### Scenario: a command that relies only on the allowlist
- **GIVEN** an offered command whose only route is the engine (`/compact` on Claude Code, `/init`, a skill)
- **THEN** it is in `CLI_BUILTINS` or is a slash invocation the engine expands, AND its name, or the name it is an alias of, is in the recorded list of the engine's runnable commands
- **AND** removing it from that route, or the engine dropping the name, fails the check

#### Scenario: an alias is not a missing command
- **GIVEN** `cost` and `review`, which the CLI runs but does not list
- **WHEN** the check compares the map against the recorded list with its aliases
- **THEN** both pass as `usage` and `code-review`

#### Scenario: the help text and the menu cannot disagree
- **GIVEN** `/help`, which is the one place a user asks what can be typed here
- **THEN** it opens the same menu, built from the same map
- **AND** a hand-written second list fails the check, because two hand-kept lists drift and neither looks incomplete on its own

#### Scenario: a command the CLI cannot run in this mode
- **GIVEN** a command the CLI refuses when driven with `--print`, such as `/resume`, `/vim` or `/rewind`
- **WHEN** it is typed in the chat
- **THEN** it is answered locally, saying so and naming what to use instead, or Topics runs its own version
- **AND** it is NOT forwarded to a process that can only refuse it

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

They SHALL be offered only on an engine that expands them: Claude Code offers both
commands and skills; Topics' native engine offers skills only, the ones its prompt
lists and its `skill` tool loads. Codex, the API engines, the ACP agents and
OpenClaw SHALL NOT be offered them, because there a typed `/name` is prose. A skill
switched off in the user's `skillOverrides` SHALL NOT be offered, and SHALL NOT be
listed in the native engine's prompt either.

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

#### Scenario: Only where the engine expands them
- **GIVEN** a command and a skill on disk
- **WHEN** the list is built for a chat on Topics' native engine
- **THEN** the skill SHALL be offered and the command SHALL NOT
- **WHEN** the list is built for a chat on Codex
- **THEN** neither SHALL be offered

#### Scenario: A switched-off skill
- **GIVEN** a skill whose name is `off` in `skillOverrides`
- **WHEN** the list is built for a Claude Code chat, or the native engine builds its prompt
- **THEN** that skill SHALL NOT be in either

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

### Requirement: CTRLTOOL-02 — La rotta esegue SOLO gli strumenti di controllo che ha registrato lei

Gli stessi cinque nomi vivono in due posti: la rotta li consegna al modello solo
per i provider di passaggio, mentre ogni altro runtime li possiede attraverso la
tavola degli strumenti e li esegue da sé. Quindi la rotta SHALL dispacciarli
SOLO per i provider di passaggio.

Un annuncio di strumento che arriva da un runtime che li esegue da sé NON SHALL
produrre né effetto collaterale né risultato: sarebbe una seconda esecuzione
della stessa chiamata. In particolare il runtime nativo annuncia con argomenti
VUOTI, quindi la seconda esecuzione falliva per «argomenti mancanti» e scriveva
un errore sopra una chiamata riuscita.

#### Scenario: annuncio dal runtime nativo
- **GIVEN** un provider che non è di passaggio
- **WHEN** viene annunciato uno strumento di controllo
- **THEN** la rotta NON SHALL eseguirlo e NON SHALL emettere nessun risultato

#### Scenario: annuncio da un provider di passaggio
- **GIVEN** un provider di passaggio
- **WHEN** viene annunciato uno strumento di controllo con i suoi argomenti
- **THEN** l'effetto collaterale SHALL avvenire e il risultato SHALL essere annunciato

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

### Requirement: MCPSRV-04 — Un server MCP protetto da OAuth si monta: l'accesso lo fa la flotta, non la persona

Un server remoto che risponde al primo `initialize` con `401` e una sfida
`www-authenticate` NON e' un server guasto: e' un server che chiede l'accesso.
La flotta SHALL distinguerlo da un `failed` con uno stato proprio (`needs-auth`)
la cui ragione dice che serve l'accesso, e nessuno dei suoi strumenti SHALL
comparire nel registro finche' l'accesso non e' fatto.

L'accesso SHALL seguire OAuth 2.1 come lo chiede il protocollo MCP: metadati
della risorsa protetta letti dalla sfida, metadati del server di autorizzazione
(la forma RFC 8414 prima, poi quella appesa, e `openid-configuration` come
ripiego), registrazione dinamica del client UNA volta per emittente e riusata
dai server dietro lo stesso emittente, PKCE con `S256`, e un ascoltatore di
ritorno su loopback che vive solo per la durata di un accesso. Un ritorno con
uno `state` sbagliato, o un codice che il server rifiuta, NON SHALL scrivere
niente.

Il token SHALL essere conservato in un file leggibile solo dal proprietario, e
NON SHALL comparire in nessun log, errore o ragione mostrata a schermo. Un token
di accesso scaduto SHALL essere rinnovato UNA volta sotto la connessione, senza
costare il montaggio; un token di rinnovo che il server rifiuta riporta il
server a `needs-auth`, non a `failed`, perche' la sola cura e' rifare l'accesso.

#### Scenario: un server protetto senza token non e' guasto
- **GIVEN** un server configurato che risponde `401` con una sfida Bearer
- **WHEN** la flotta lo monta
- **THEN** il suo stato SHALL essere `needs-auth`, con una ragione che parla di accesso
- **AND** i suoi strumenti NON SHALL essere nel registro

#### Scenario: dopo l'accesso lo stesso server monta
- **GIVEN** un accesso completato dal ritorno su loopback
- **WHEN** la flotta viene rimontata
- **THEN** il server SHALL essere `ready` e i suoi strumenti richiamabili

#### Scenario: un token morto sotto la connessione si rinnova una volta
- **GIVEN** un token di accesso che il server non riconosce piu' mentre il file lo crede vivo
- **WHEN** la flotta lo monta
- **THEN** la richiesta SHALL essere ripetuta con un token rinnovato, e il montaggio SHALL riuscire

#### Scenario: un ritorno con lo state sbagliato non scrive niente
- **GIVEN** un accesso avviato
- **WHEN** il ritorno porta uno `state` diverso da quello emesso
- **THEN** SHALL essere rifiutato e il file dei token SHALL restare vuoto

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

### Requirement: CMDUI-01 — Il menu «/» offre ciò che funziona nella chat aperta, in tre gruppi, letto dal motore

Il menu «/» del composer SHALL essere costruito per la chat aperta, sul motore che
il topic DICHIARA (CMD-08), in tre gruppi nell'ordine: «Topics» (i comandi che
Topics esegue o i controlli che apre), il gruppo del motore, «Le tue skill».

Il gruppo del motore SHALL venire dall'elenco che il motore stesso dà: per Claude
Code `system/init.slash_commands` e `system/commands_changed`; per gli agenti ACP
`available_commands_update`. Codex, le API, OpenClaw e il motore di Topics NON SHALL
avere un gruppo del motore. Prima che la chat abbia un elenco suo il menu SHALL
usare l'ultimo elenco visto per lo stesso progetto e motore, e NON SHALL avviare un
processo solo per leggerlo.

Il gruppo «Le tue skill» SHALL esserci sui motori che le espandono, come dice
SKILL-01: su Claude Code le skill e i comandi tuoi, sul motore di Topics le skill
(quelle che il suo prompt elenca e il suo tool `skill` carica). Su Codex, sulle API,
sugli agenti ACP e su OpenClaw NON SHALL esserci.

Ogni nome SHALL passare per la mappa dei comandi di Topics, che gli dà un tipo
(`topics`, `control`, `engine`, `refused`, `hidden`), dice se fa lavorare il
modello e tiene gli alias del motore. Un alias SHALL comportarsi come il suo nome
e NON SHALL comparire come riga a parte. Un nome `refused` o `hidden` NON SHALL
comparire nel menu. Una riga che fa lavorare il modello SHALL dirlo («turno»); una
che apre un controllo SHALL dire quale.

#### Scenario: una chat Claude Code
- **GIVEN** una chat dichiarata `claude-code` la cui CLI ha mandato un `init` con `init`, `code-review`, `compact`, `agents` e la skill `vai`
- **WHEN** scrivo «/»
- **THEN** il menu ha i gruppi Topics, Claude Code e Le tue skill
- **AND** /init, /code-review e /vai sono segnati «turno»
- **AND** /agents non c'è, e /review non è una riga a parte

#### Scenario: un alias scritto a mano
- **GIVEN** la stessa chat
- **WHEN** mando `/review`
- **THEN** parte come /code-review
- **WHEN** mando `/cost`
- **THEN** succede quello che succede con /usage (CMDUI-05)

#### Scenario: una chat sul motore di Topics
- **GIVEN** una chat dichiarata `topics` e la skill `vai` installata e accesa
- **WHEN** scrivo «/»
- **THEN** il menu ha i gruppi Topics e Le tue skill, e nessun gruppo del motore
- **AND** /vai è segnata «turno»

#### Scenario: una chat Codex
- **GIVEN** una chat dichiarata `codex`
- **WHEN** scrivo «/»
- **THEN** il menu ha solo il gruppo Topics
- **AND** non offre /compact né alcuna skill

#### Scenario: nessun elenco ancora visto
- **GIVEN** un server appena avviato e una chat Claude Code nuova che non ha ancora avviato la sua CLI
- **WHEN** scrivo «/»
- **THEN** il menu ha il gruppo Topics e le skill trovate nelle cartelle
- **AND** nessun processo CLI è stato avviato per costruirlo

#### Scenario: il filtro
- **WHEN** scrivo «/re»
- **THEN** restano solo i nomi che iniziano così, ognuno nel suo gruppo
- **AND** un gruppo senza righe non compare

### Requirement: CMDUI-02 — Un comando che in Topics ha un controllo apre quel controllo

/model, /effort, /context, /permissions e /fast scritti senza argomento (o scelti
dal menu) SHALL aprire, nel composer della chat, rispettivamente il selettore del
modello, il cursore dello sforzo, l'ispettore del contesto, il selettore
dell'autonomia e l'interruttore della modalità veloce, con il fuoco dentro. Con un
argomento valido SHALL applicarlo senza aprire niente. /mcp SHALL aprire il
pannello Strumenti ancorato al «+» del composer della chat, lo stesso che apre la
riga «Strumenti» di quel menu; /config SHALL aprire il menu utente. /usage e /cost
seguono CMDUI-05.

Nessuno di questi SHALL arrivare al motore.

#### Scenario: /model scelto dal menu
- **GIVEN** una chat Claude Code
- **WHEN** scelgo /model dal menu «/»
- **THEN** il selettore del modello del composer è aperto
- **AND** la CLI non ha ricevuto nessun messaggio

#### Scenario: /model con un nome
- **WHEN** mando `/model opus`
- **THEN** il modello della chat è `opus` e nessun selettore è aperto

#### Scenario: /mcp
- **WHEN** mando /mcp
- **THEN** il pannello Strumenti è aperto accanto al «+» del composer
- **AND** nessuna richiesta ha montato la flotta MCP per aprirlo

#### Scenario: /config
- **WHEN** mando /config
- **THEN** il menu utente è aperto

### Requirement: CMDUI-03 — /resume elenca le sessioni Claude del progetto nate fuori da Topics e le apre come chat

/resume in una chat legata a un progetto SHALL aprire, sopra il composer, l'elenco
delle sessioni Claude Code di quel progetto che nessuna chat di Topics possiede,
dalla più recente, 20 alla volta, con: titolo (quello dato con /rename, poi quello
generato, poi l'ultima domanda), ramo, quando, e «attiva adesso» se il transcript
è stato toccato negli ultimi 15 minuti. Finché ce ne sono altre, l'ultima riga SHALL
essere «Carica più vecchie», che aggiunge le 20 dopo. La parola dopo `/resume `
SHALL filtrare su titolo e ramo.

La lettura SHALL essere limitata: solo le cartelle dei transcript il cui nome
codificato inizia col percorso del progetto, il cui `cwd` letto SHALL comunque
stare dentro il progetto; le sessioni che Topics possiede scartate dal nome del
file prima di leggerlo; la coda (al più 64 KB) letta solo per le righe della pagina,
con I/O asincrono e mai il file intero. Le letture di /resume NON SHALL togliere
voci alla cache del censimento delle sessioni esterne, né il censimento alle sue.

Scegliere una riga SHALL adottare la sessione (`POST /api/topics/adopt-claude`) e
aprire la chat che ne nasce; il turno dopo SHALL continuare la stessa sessione. Una
sessione attiva SHALL chiedere conferma prima. In una chat senza progetto, o con
l'elenco vuoto, SHALL rispondere con una scheda che dice perché e dove guardare.

/resume NON SHALL mai arrivare al motore.

#### Scenario: riprendere una sessione dal terminale
- **GIVEN** un progetto con due transcript non posseduti da Topics, uno con `custom-title` «Menu utente» e uno con solo `last-prompt`
- **WHEN** mando `/resume`
- **THEN** l'elenco mostra «Menu utente» e l'ultima domanda dell'altro, il più recente in cima
- **WHEN** scelgo «Menu utente»
- **THEN** si apre una chat nuova con la storia importata
- **AND** il turno dopo avvia la CLI con `--resume` e l'id di quella sessione

#### Scenario: una sessione già adottata
- **GIVEN** un transcript già legato a una chat di Topics
- **WHEN** mando `/resume`
- **THEN** quel transcript non è nell'elenco

#### Scenario: più di una pagina
- **GIVEN** un progetto con 25 transcript non posseduti da Topics
- **WHEN** mando `/resume`
- **THEN** l'elenco ha 20 righe e «Carica più vecchie»
- **AND** le code lette sono 20
- **WHEN** scelgo «Carica più vecchie»
- **THEN** l'elenco ha 25 righe e «Carica più vecchie» non c'è più

#### Scenario: le cartelle degli altri progetti
- **GIVEN** transcript recenti in una cartella di un altro progetto
- **WHEN** mando `/resume`
- **THEN** nessuna coda di quella cartella è stata letta

#### Scenario: il censimento non perde la sua cache
- **GIVEN** il censimento delle sessioni esterne ha appena letto le sue code
- **WHEN** mando `/resume` e poi il censimento gira di nuovo senza che nessun file sia cambiato
- **THEN** il censimento non rilegge nessuna coda

#### Scenario: una sessione ancora attiva
- **GIVEN** un transcript toccato 2 minuti fa
- **WHEN** lo scelgo
- **THEN** una conferma dice che è ancora attiva in un terminale prima di adottarla

#### Scenario: nessun progetto
- **GIVEN** una chat senza progetto
- **WHEN** mando `/resume`
- **THEN** una scheda dice che /resume elenca le sessioni di un progetto
- **AND** il motore non ha ricevuto nessun messaggio

### Requirement: CMDUI-04 — La risposta di un comando è una scheda della pane, non un messaggio

Un comando che risponde con del testo (/status, /project, /goal, /rewind, /fork
quando rifiuta, l'esito di /compact, i nomi `refused`, le risposte locali della CLI)
SHALL disegnare la risposta in una scheda in coda ai messaggi della pane. Una
risposta locale della CLI è un messaggio con `model: "<synthetic>"` in un turno
partito da un comando che finisce con `num_turns: 0`; un `<synthetic>` in un turno
che non è partito da un comando NON SHALL finire nella scheda. La scheda SHALL
restare finché la persona la chiude, manda il messaggio dopo o un altro comando la
sostituisce; NON SHALL avere un timer.

La scheda NON SHALL essere salvata nel thread né entrare nella storia mandata al
motore; al ricarico NON SHALL esserci.

/compact SHALL mostrare la scheda «in corso» finché arriva l'esito: i token prima
e dopo, oppure il motivo del fallimento detto dalla CLI.

#### Scenario: /status resta
- **WHEN** mando `/status`
- **THEN** una scheda «Stato della sessione» mostra il modello, l'effort e l'autonomia
- **AND** dopo 6 secondi è ancora lì
- **WHEN** mando un messaggio
- **THEN** la scheda non c'è più

#### Scenario: una risposta locale della CLI
- **GIVEN** la CLI risponde a `/output-style` con un messaggio `<synthetic>` e `num_turns: 0`
- **THEN** il testo compare dentro la scheda
- **AND** non compare come messaggio dell'agente, né dopo un ricarico

#### Scenario: /compact fallisce
- **GIVEN** la CLI risponde a `/compact` con `compact_result: "failed"`, `compact_error: "Not enough messages to compact."` e un messaggio `<synthetic>` con la stessa frase
- **THEN** la scheda passa da «in corso» a un errore che riporta quella frase, letta dentro la scheda
- **AND** nessun messaggio dell'agente la ripete

### Requirement: CMDUI-05 — /usage e /cost aprono Provider e chiavi dal selettore, con la settimana

/usage e /cost SHALL aprire il pannello Provider e chiavi ancorato al selettore del
modello del composer della chat, lo stesso che apre l'ultima riga del selettore
(SETHOME-01 della change `sidebar-menu-settings`), e NON SHALL arrivare al motore.

In cima al pannello, sotto l'abbonamento Claude e la finestra di 5 ore che
USERMENU-10 vi mette già, SHALL esserci la finestra della settimana: una barra, la
percentuale e quando si azzera, con giorno e ora, dalle letture che i turni di
Claude Code già mandano. La riga compatta del piano nel selettore SHALL aggiungere la
percentuale della settimana dopo quella delle 5 ore. Oltre la soglia dell'avviso la
barra e la cifra SHALL cambiare colore come quelle delle 5 ore. Senza una lettura il
pannello SHALL dirlo.

#### Scenario: con una lettura
- **GIVEN** una lettura con la finestra di 5 ore al 38% e la settimana al 78%
- **WHEN** mando `/usage`
- **THEN** il pannello Provider e chiavi è aperto accanto al selettore del modello del composer
- **AND** le due barre dicono 38% e 78% con quando si azzerano
- **AND** la barra della settimana ha il colore dell'avviso
- **AND** la riga del piano nel selettore dice «5 h al 38% · sett. 78%»

#### Scenario: /cost
- **WHEN** mando `/cost`
- **THEN** è aperto lo stesso pannello
- **AND** la CLI non ha ricevuto nessun messaggio

#### Scenario: senza lettura
- **GIVEN** nessuna lettura dal riavvio
- **WHEN** mando `/usage`
- **THEN** il pannello dice che la lettura arriva col primo turno di Claude Code

### Requirement: CMDUI-06 — Ogni motore ha i suoi comandi, detti per nome

/compact SHALL compattare su Claude Code (la CLI), su OpenClaw (il gateway) e sul
motore di Topics (la sua compattazione chiamata subito, con lo stesso separatore
di quella automatica); sugli altri motori NON SHALL essere offerto, e scritto SHALL
rispondere che quel motore non compatta a richiesta.

/clear, /new e /reset SHALL far dimenticare la sessione su ogni motore che ne ha
una, gli agenti ACP compresi (CMD-09). /reasoning SHALL esserci solo su OpenClaw,
SHALL dire che decide se il ragionamento si vede, e SHALL passare il suo argomento
(`on`, `off`, `stream`) anche quando è scritto nello stesso messaggio.

#### Scenario: /compact sul motore di Topics
- **GIVEN** una chat sul motore di Topics sotto la soglia della compattazione, senza un turno in volo
- **WHEN** mando `/compact`
- **THEN** la storia è compattata e compare il separatore con i token prima e dopo
- **AND** nessun turno del modello è partito

#### Scenario: /compact su Codex
- **GIVEN** una chat dichiarata `codex`
- **WHEN** scrivo `/compact` e lo mando
- **THEN** una scheda dice che Codex non compatta a richiesta
- **AND** Codex non ha ricevuto nessun messaggio

#### Scenario: /reasoning con l'argomento
- **GIVEN** una chat OpenClaw
- **WHEN** mando `/reasoning off`
- **THEN** l'argomento `off` arriva al gateway

### Requirement: CMDUI-07 — Il menu si usa da tastiera e dal telefono, e /help è il menu

Il menu «/» e l'elenco di /resume SHALL usare il guscio di `SuggestionMenu`,
attaccato al composer anche sotto 768 px, e NON SHALL diventare un foglio. Le
frecce SHALL attraversare i gruppi senza fermarsi alle intestazioni; Invio e Tab
SHALL scegliere; Esc SHALL chiudere. Sul telefono ogni riga SHALL essere alta
almeno 44 px.

Scegliere un comando che non vuole argomenti SHALL eseguirlo; uno che li vuole
SHALL inserirlo con lo spazio.

/help SHALL aprire il menu «/» intero, con una riga in fondo che dice che i
comandi di Topics non costano e quelli segnati «turno» fanno lavorare il modello.

Il menu «+» del composer NON SHALL ripetere i comandi: SHALL avere una riga
«Comandi /» che apre il menu «/».

Un messaggio che è un'invocazione (SKILL-03) NON SHALL prendere la citazione di una
risposta armata; la citazione SHALL restare armata per il messaggio dopo.

#### Scenario: tastiera
- **GIVEN** il menu «/» aperto sulla prima riga del gruppo Topics
- **WHEN** premo freccia giù fino alla prima riga del gruppo del motore
- **THEN** nessuna intestazione riceve il fuoco
- **WHEN** premo Invio su /status
- **THEN** /status è eseguito senza un secondo Invio

#### Scenario: telefono
- **GIVEN** una finestra di 390x844
- **WHEN** scrivo «/»
- **THEN** il menu sta sopra il composer, il campo resta visibile e toccabile
- **AND** ogni riga è alta almeno 44 px

#### Scenario: /help
- **WHEN** mando `/help`
- **THEN** il menu «/» è aperto con tutti i suoi gruppi

#### Scenario: un comando con una risposta armata
- **GIVEN** una chat Claude Code con «Rispondi» armato su un messaggio
- **WHEN** mando `/code-review`
- **THEN** la CLI riceve un messaggio che inizia con `/code-review`
- **AND** la citazione è ancora armata nel composer

### Requirement: CMDUI-08 — Nei composer della board un comando non diventa prosa in silenzio

Nel composer del cassetto di una card e nel commento della card, un testo che
inizia con un nome della mappa dei comandi (non una skill) SHALL mostrare sopra il
campo la riga «I comandi vanno dati nella chat dell'agente» con «Apri la
sessione», che apre la chat dell'agente della card; senza una sessione viva la
riga SHALL dire che lì un comando è testo. Invio SHALL mandare il testo come oggi.

#### Scenario: /compact nel cassetto
- **GIVEN** una card con una sessione d'agente viva
- **WHEN** scrivo `/compact` nel cassetto
- **THEN** compare la riga con «Apri la sessione»
- **WHEN** la tocco
- **THEN** si apre la chat dell'agente della card

### Requirement: CMDUI-09 — Una skill riceve il contesto accanto al comando, non davanti

Quando il messaggio è un'invocazione (SKILL-03) di un nome che non è un built-in
della CLI, su Claude Code il turno SHALL arrivare alla CLI come UN solo messaggio
utente con due blocchi di testo: il blocco `<context>` nel primo e il comando NUDO,
esattamente come l'ha scritto la persona, nell'ultimo. La CLI legge il comando
dall'ultimo blocco, quindi `$ARGUMENTS` SHALL essere solo ciò che ha scritto la
persona. Il contesto NON SHALL viaggiare negli argomenti di avvio:
`--append-system-prompt` SHALL restare il prompt fisso di Topics, senza slot.

Un messaggio che non è un'invocazione SHALL avere il contesto come oggi, in una
stringa sola con `<context>` davanti al testo.

#### Scenario: una skill al primo turno
- **GIVEN** una chat Claude Code nuova
- **WHEN** il primo messaggio è `/vai solo il bug X`
- **THEN** la CLI riceve UN messaggio utente con due blocchi di testo
- **AND** il primo blocco contiene `<context>` e l'ultimo è esattamente `/vai solo il bug X`
- **AND** `--append-system-prompt` negli argomenti di avvio non contiene il contesto

#### Scenario: una skill che solo la CLI conosce
- **GIVEN** una chat Claude Code la cui CLI ha elencato una skill nel suo `system/init`
- **WHEN** mando quella skill con un argomento
- **THEN** il comando arriva nudo nell'ultimo blocco, col contesto nel blocco prima

#### Scenario: un messaggio normale
- **GIVEN** una chat Claude Code nuova
- **WHEN** il primo messaggio è `ciao`
- **THEN** la CLI riceve una stringa sola con `<context>` davanti a `ciao`, come oggi
- **AND** un percorso incollato come `/tmp/x` non è una skill e ha la stessa forma

### Requirement: CMDUI-10 — Un messaggio appuntato si vede

Un messaggio appuntato con «Appunta» SHALL portare un segno visibile anche senza il
puntatore sopra. Con almeno un appunto, sopra i messaggi della chat SHALL esserci una
riga «N appuntati · restano nel contesto dell'agente» che apre l'elenco degli
appunti; ogni voce SHALL portare al suo messaggio e SHALL potersi staccare da lì.
Senza appunti la riga NON SHALL esserci.

#### Scenario: appuntare
- **GIVEN** una chat con tre messaggi e nessun appunto
- **WHEN** appunto il secondo
- **THEN** il secondo messaggio porta il segno
- **AND** sopra i messaggi c'è «1 appuntato · resta nel contesto dell'agente»
- **WHEN** apro la riga e stacco l'appunto
- **THEN** la riga non c'è più e il messaggio non porta il segno

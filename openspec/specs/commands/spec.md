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

#### Scenario: an allowlist entry that can never match
- **GIVEN** an entry written with a leading slash, whitespace or an upper-case letter
- **WHEN** the matcher compares the first token of a message against the list
- **THEN** that entry can never match, and the check fails instead of leaving it there reading as coverage

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


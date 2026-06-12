## ADDED Requirements

### Requirement: Reopen most recently closed tab

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

### Requirement: Single reopen entry point shared by all surfaces

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

### Requirement: Recently-closed history is durable and bounded

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

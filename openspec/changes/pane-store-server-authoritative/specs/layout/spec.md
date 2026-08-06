# Delta: layout — server-authoritative pane state

## ADDED Requirements

### Requirement: PANE-AUTH-01 — The server owns what exists; hydrating replaces

The server SHALL be the sole authority over which panes, groups, and spaces exist.
A client SHALL NOT send a full state snapshot; it SHALL send intents describing what
it wants to happen. When authoritative state arrives, the client SHALL **replace**
its view of what exists rather than merge it with a local copy.

The client's rendered state SHALL be composed in this order and no other: the
authoritative state, then the client's own unconfirmed intents re-applied on top,
then panes that exist only locally and are never sent (drafts).

#### Scenario: A client never uploads a state snapshot
- **GIVEN** a user opens, closes, or reorders panes
- **WHEN** the client informs the server
- **THEN** it SHALL send intents, not a snapshot of the whole pane set

#### Scenario: Authoritative state replaces, it does not union
- **GIVEN** a client holds a local view containing a pane the server does not list
- **AND** that pane is not an unconfirmed local intent and not a draft
- **WHEN** authoritative state arrives
- **THEN** that pane SHALL NOT appear in the rendered state

#### Scenario: Unconfirmed intents survive a replacement
- **GIVEN** a client has closed a pane and the intent has not yet been confirmed
- **WHEN** authoritative state arrives that still lists that pane as open
- **THEN** the rendered state SHALL show the pane as closed
- **AND** the intent SHALL remain queued until it is confirmed or rejected

#### Scenario: Device-local pointers are re-resolved after a replacement
- **GIVEN** the focused pane, or the active space, refers to something the incoming authoritative state no longer contains
- **WHEN** the replacement is applied
- **THEN** the client SHALL move that pointer to a valid target
- **AND** SHALL NOT leave it referring to something that does not exist

### Requirement: PANE-AUTH-02 — Ordering is by server revision, never by wall clock

The system SHALL order competing pane operations by a revision counter allocated by
the server per scope. The system SHALL NOT decide whether a pane is open or closed by
comparing timestamps produced on different machines.

A closed pane SHALL record the revision at which it was closed. An intent SHALL carry
the revision its author had observed. The server SHALL reject an open or reopen whose
observed revision predates the pane's close revision, because its author had not yet
seen the close.

#### Scenario: A stale device cannot resurrect a closed pane
- **GIVEN** a pane was closed on one device
- **AND** another device holds a local view from before that close
- **WHEN** the stale device connects and sends its intents
- **THEN** the pane SHALL remain closed
- **AND** the close SHALL NOT be retracted on the server

#### Scenario: A legitimate reopen still works
- **GIVEN** a device has observed that a pane was closed
- **WHEN** the user explicitly reopens it on that device
- **THEN** the pane SHALL become open again for every device

#### Scenario: No decision compares two wall clocks
- **GIVEN** any pane whose open and close were recorded on different machines
- **WHEN** the system decides whether it exists
- **THEN** the decision SHALL use server revisions only

### Requirement: PANE-AUTH-03 — Intents are queued durably and applied optimistically

The client SHALL apply every intent to its own state synchronously, before the intent
is sent, so that code which reads state immediately after issuing an intent observes
the result. The client SHALL hold unconfirmed intents in durable per-origin storage,
SHALL re-apply them after every replacement, and SHALL remove one only when the server
confirms it. A rejected intent SHALL be undone visibly rather than dropped silently.

#### Scenario: State is readable immediately after an intent is issued
- **GIVEN** code issues an intent and then reads the store on the next line
- **WHEN** it reads
- **THEN** it SHALL observe the intent's effect, without waiting for the server

#### Scenario: An intent survives the page closing
- **GIVEN** the user closes a pane and immediately closes the window
- **WHEN** the application starts again
- **THEN** the pane SHALL be closed
- **AND** the pending intent SHALL have been sent or SHALL still be queued

#### Scenario: An intent survives a disconnection
- **GIVEN** the connection to the server is down
- **WHEN** the user closes a pane
- **AND** the connection is restored
- **THEN** the close SHALL reach the server

#### Scenario: A rejected intent is surfaced, not swallowed
- **GIVEN** the server rejects an intent
- **WHEN** the client receives the rejection
- **THEN** the client SHALL undo the optimistic effect
- **AND** SHALL NOT remove the intent as though it had succeeded

#### Scenario: Two tabs on one device do not send twice
- **GIVEN** two tabs of the same origin hold the same queue
- **WHEN** intents are sent
- **THEN** exactly one tab SHALL send them

### Requirement: PANE-AUTH-04 — Project view panes have a deterministic identity

Per-project singleton view panes (git, files, dashboard, activity, browser, and the
like) SHALL derive their identifier from the project and the view type, so the same
logical pane has the same identifier on every device. The system SHALL NOT rely on
de-duplicating them by type to hide device-specific random identifiers.

Re-identifying an existing pane SHALL preserve the key that its rendering and
residency are indexed by, so the pane is not remounted.

#### Scenario: The same view has the same identity on two devices
- **GIVEN** two devices open the same view of the same project
- **WHEN** their state is compared
- **THEN** both SHALL refer to it by the same identifier
- **AND** it SHALL appear once, not twice

#### Scenario: Re-identification does not remount
- **GIVEN** a project view pane created before this change, holding a live embedded browser
- **WHEN** it is migrated to its deterministic identifier
- **THEN** the embedded browser SHALL NOT be torn down and recreated

## MODIFIED Requirements

### Requirement: LAYOUT-01 — PanelGrid, Split, Resize & Persistence

The system SHALL provide a tiling pane grid supporting split, resize, reorder, and
close, and SHALL persist the arrangement so it survives a reload.

Persistence SHALL be split by ownership. **What exists** — which panes, groups, and
spaces there are — is owned by the server per `PANE-AUTH-01`. **Where the user is
looking** — the focused pane, the active space, scroll positions, and the grid
geometry — is device-local, SHALL NOT be synchronised to other devices, and SHALL
survive a reload on its own device.

Device-local geometry SHALL NOT be discarded because the authoritative pane set is
momentarily empty or reduced: the absence of a record is not an empty set.

#### Scenario: Grid geometry stays on its device
- **GIVEN** a user arranges the grid on one device
- **WHEN** they open the app on another device
- **THEN** the second device SHALL keep its own arrangement
- **AND** SHALL NOT adopt the first device's geometry

#### Scenario: A transiently empty pane set does not destroy the saved layout
- **GIVEN** a saved grid geometry on a device
- **WHEN** authoritative state arrives that momentarily contains no panes
- **THEN** the saved geometry SHALL survive
- **AND** SHALL be re-applied once panes are present again

#### Scenario: Focus changes cause no network traffic
- **GIVEN** the user moves focus between panes, or switches the active space
- **WHEN** those changes are applied
- **THEN** the client SHALL send no request to the server

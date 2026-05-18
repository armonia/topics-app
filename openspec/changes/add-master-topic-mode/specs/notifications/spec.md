## Purpose

Specifies non-invasive notification handling: triple-layer event capture (Darwin notifications + FS watch + polling), severity routing (P0/P1/P2), and Focus mode awareness. Only actionable events ever notify the user.

## Background

Common preconditions:
- The user is logged into Topics App
- The Electron tray app is running
- `claude` CLI is configured with Topics hooks in `~/.claude/settings.json`

## Requirements

### Requirement: NOTIF-01 — Triple-layer event capture

The system SHALL capture Claude Code lifecycle events through three complementary mechanisms with no missed events under normal operation.

#### Scenario: Real-time Darwin notification delivery
- **GIVEN** a Claude Code session is active in a topic
- **AND** the user's `~/.claude/settings.json` has Topics hooks configured for `Stop` and `PreToolUse`
- **WHEN** the session emits a `Stop` event awaiting permission
- **THEN** within 500ms a Darwin notification is posted to the Topics tray app
- **AND** the tray badge increments

#### Scenario: FS watcher backup catches missed Darwin notif
- **GIVEN** the Darwin notification path is unavailable (e.g. tray app restart)
- **WHEN** a Claude hook writes to `~/.topics/events.jsonl`
- **THEN** within 2s the FS watcher picks up the new line
- **AND** the event is processed identically to a real-time notification

#### Scenario: Polling fallback closes the gap
- **GIVEN** both Darwin and FS watcher failed to deliver an event
- **WHEN** 5 seconds pass since the last successful event
- **THEN** the polling tick reads `~/.topics/events.jsonl` tail
- **AND** any unprocessed entries are processed

### Requirement: NOTIF-02 — Severity routing

The system SHALL route notifications to channels based on event severity, with strict default of "actionable only".

#### Scenario: P0 event triggers sound + desktop + push
- **GIVEN** a teammate session crashes or hits a blocker
- **WHEN** the event is classified as P0
- **THEN** a desktop notification is shown with sound
- **AND** an iOS push is sent via the existing web-push channel
- **AND** the tray badge shows red dot

#### Scenario: P1 event triggers silent desktop + badge only
- **GIVEN** a teammate completes a task awaiting review
- **WHEN** the event is classified as P1
- **THEN** a silent desktop notification is shown
- **AND** the tray badge count increments
- **AND** no iOS push is sent

#### Scenario: P2 event updates badge only
- **GIVEN** a teammate transitions from working to idle without completing a task
- **WHEN** the event is classified as P2
- **THEN** the tray badge is refreshed
- **AND** no desktop notification is shown

### Requirement: NOTIF-03 — Focus mode awareness

The system SHALL suppress non-P0 notifications during macOS Focus or Do Not Disturb modes.

#### Scenario: P1 suppressed during Focus mode
- **GIVEN** macOS Focus mode is active
- **WHEN** a P1 event is emitted
- **THEN** the desktop notification is suppressed
- **AND** the tray badge still increments
- **AND** the event is queued for replay when Focus exits (optional, may be omitted in V1)

#### Scenario: P0 always delivered even in Focus mode
- **GIVEN** macOS Focus mode is active
- **WHEN** a P0 event is emitted
- **THEN** the desktop notification is shown with sound
- **AND** the iOS push is delivered

### Requirement: NOTIF-04 — Click routes to context

The system SHALL deep-link notification clicks to the originating pane.

#### Scenario: Click on awaiting-review notification focuses pane
- **GIVEN** a P1 notification for "Task X awaiting review" is visible
- **WHEN** the user clicks the notification
- **THEN** Topics window comes to front
- **AND** the pane hosting the teammate Topic for Task X is focused
- **AND** the task detail panel opens with the reasoning trail visible

### Requirement: NOTIF-05 — No routine activity noise

The system SHALL NOT emit notifications for routine activity (thinking, tool_use, progress updates, idle transitions to and from working).

#### Scenario: Tool use does not notify
- **GIVEN** a teammate session is making rapid tool calls
- **WHEN** 50 `tool_use` events fire over 10 seconds
- **THEN** zero notifications are emitted
- **AND** the tray badge does not change
- **AND** the pane reasoning trail updates inline

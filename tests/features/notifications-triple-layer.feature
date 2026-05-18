Feature: Non-invasive triple-layer notification capture

  Background:
    Given the user is logged into Topics App
    And the Electron tray app is running
    And the Claude Code hooks for Topics are installed

  @actor:developer @page:tray @spec:NOTIF-01
  Scenario: Real-time Darwin notification arrives within 500ms
    Given a Claude session in a topic is active
    When the session emits a Stop event awaiting permission
    Then within 500ms a Darwin notification is posted to the Topics tray app
    And the tray badge increments by one

  @actor:developer @page:tray @spec:NOTIF-01
  Scenario: FS watcher backup catches missed Darwin notif
    Given the Darwin notification path is temporarily unavailable
    When a Claude hook appends an event to "~/.topics/events.jsonl"
    Then within 2 seconds the FS watcher processes the event
    And the event is handled identically to the real-time path

  @actor:developer @page:tray @spec:NOTIF-01
  Scenario: Polling fallback closes any remaining gap
    Given both Darwin and FS watcher failed to deliver an event
    When 5 seconds pass since the last successful event
    Then the polling tick reads the events.jsonl tail
    And any unprocessed entries are processed

  @actor:developer @page:tray @spec:NOTIF-05
  Scenario: Routine tool_use events do not notify
    Given a teammate session is making rapid tool calls
    When 50 tool_use events fire over 10 seconds
    Then zero notifications are emitted
    And the tray badge count is unchanged

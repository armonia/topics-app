## ADDED Requirements

### Requirement: Native notifications for new messages
The Electron main process SHALL send native macOS notifications when new messages arrive in topics with unread counts, provided the main window is not focused on that topic.

#### Scenario: Notification shown for new message when window hidden
- **WHEN** a new message arrives in a topic
- **AND** the main window is hidden or minimized
- **THEN** a native notification is shown with the topic name as title and a preview of the message body (max 100 characters)

#### Scenario: Notification shown for new message when window visible but different topic
- **WHEN** a new message arrives in topic A
- **AND** the main window is visible but focused on topic B
- **THEN** a native notification is shown for topic A

#### Scenario: No notification when window is focused on the same topic
- **WHEN** a new message arrives in topic A
- **AND** the main window is visible and focused on topic A
- **THEN** no notification is sent for that message

#### Scenario: Click notification focuses the topic
- **WHEN** the user clicks a message notification
- **THEN** the main window is shown and focused
- **AND** the app navigates to the topic that triggered the notification

#### Scenario: Rate limiting prevents notification spam
- **WHEN** multiple messages arrive for the same topic within 10 seconds
- **THEN** only one notification is sent for that topic during the cooldown period

### Requirement: Native notifications for agent events
The Electron main process SHALL send native notifications for significant agent lifecycle events.

#### Scenario: Notification on agent completion
- **WHEN** an agent session completes
- **THEN** a notification is shown with title "Agent completed" and the agent name in the body

#### Scenario: Notification on approval request
- **WHEN** an approval request is created
- **THEN** a notification is shown with title "Approval needed" and the tool/action name in the body
- **AND** clicking the notification focuses the relevant topic

### Requirement: Native notifications for gateway status changes
The Electron main process SHALL send native notifications when the OpenClaw gateway connection status changes.

#### Scenario: Notification on gateway disconnect
- **WHEN** the gateway status changes from connected to disconnected
- **THEN** a notification is shown with title "OpenClaw offline" and body "Gateway connection lost"

#### Scenario: Notification on gateway reconnect
- **WHEN** the gateway status changes from disconnected to connected
- **THEN** a notification is shown with title "OpenClaw online" and body "Gateway connection restored"

### Requirement: Notification reference lifecycle management
Active notification instances SHALL be retained to prevent garbage collection of event handlers.

#### Scenario: Notification references retained until dismissed
- **WHEN** a notification is created
- **THEN** a reference is stored in a Map keyed by notification ID
- **AND** the reference is removed when the notification click or close event fires

#### Scenario: Stale notification references cleaned up
- **WHEN** a notification reference has been retained for more than 5 minutes without a click or close event
- **THEN** the reference is removed during the periodic cleanup sweep

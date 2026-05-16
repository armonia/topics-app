## ADDED Requirements

### Requirement: Dynamic tray context menu with system status
The tray context menu SHALL be rebuilt dynamically to display current gateway status, active agent sessions, topics with unread messages, and quick actions.

#### Scenario: Menu shows gateway connected status
- **WHEN** the gateway is connected
- **THEN** the tray menu displays a status item "Gateway: Connected" with a checkmark indicator
- **AND** the item is non-clickable (informational)

#### Scenario: Menu shows gateway disconnected status
- **WHEN** the gateway is disconnected
- **THEN** the tray menu displays a status item "Gateway: Disconnected" with a cross indicator

#### Scenario: Menu shows active agent count
- **WHEN** there are active agent sessions
- **THEN** the tray menu displays "Agents: N active" where N is the count of active sessions

#### Scenario: Menu shows topics with unread messages
- **WHEN** one or more topics have unread messages
- **THEN** the tray menu lists each topic with unreads, showing the topic name and unread count
- **AND** a maximum of 10 topics are shown, ordered by most recent unread activity
- **AND** clicking a topic item SHALL focus the main window and navigate to that topic

#### Scenario: Menu shows no unreads state
- **WHEN** no topics have unread messages
- **THEN** the unread topics section is omitted from the menu

#### Scenario: Menu includes Mark All Read action
- **WHEN** there are unread messages
- **THEN** the tray menu includes a "Mark All Read" action item
- **AND** clicking it SHALL mark all topics as read via the server API

#### Scenario: Menu rebuild is debounced
- **WHEN** multiple state changes arrive within 1 second
- **THEN** the tray menu is rebuilt only once after the changes settle

### Requirement: Dynamic tray icon reflects current state
The tray icon SHALL change to reflect the current application state (normal, unread, disconnected).

#### Scenario: Normal state icon
- **WHEN** there are no unread messages and the gateway is connected
- **THEN** the tray displays the normal template icon

#### Scenario: Unread state icon with count
- **WHEN** there are unread messages
- **THEN** the tray displays the unread template icon
- **AND** tray.setTitle() shows the total unread count next to the icon

#### Scenario: Disconnected state icon
- **WHEN** the gateway is disconnected
- **THEN** the tray displays the disconnected template icon

#### Scenario: Icon priority (unread over disconnected)
- **WHEN** there are unread messages AND the gateway is disconnected
- **THEN** the tray displays the unread template icon (unread takes visual priority)

#### Scenario: Title cleared when no unreads
- **WHEN** all messages are read
- **THEN** tray.setTitle('') is called to remove the count text

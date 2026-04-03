## ADDED Requirements

### Requirement: WebSocket connection from Electron main process
The Electron main process SHALL maintain a persistent WebSocket connection to ws://localhost:3333/ws for real-time state updates, replacing the HTTP polling mechanism.

#### Scenario: WebSocket connects on app ready
- **WHEN** the Electron app starts and the server is reachable
- **THEN** a WebSocket connection is established to ws://localhost:3333/ws
- **AND** the connection receives connected and unread:init messages

#### Scenario: WebSocket reconnects with exponential backoff
- **WHEN** the WebSocket connection drops
- **THEN** the main process attempts to reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- **AND** reconnection attempts continue until successful

#### Scenario: Unread updates received in real-time
- **WHEN** the server broadcasts an unread:updated event
- **THEN** the main process receives it and updates internal unread state
- **AND** tray icon, title, and menu are updated accordingly

#### Scenario: Gateway status received in real-time
- **WHEN** the server broadcasts a gateway:status event
- **THEN** the main process receives it and updates internal gateway state
- **AND** tray icon and menu are updated accordingly

#### Scenario: Agent session updates received in real-time
- **WHEN** the server broadcasts an agents:sessions event
- **THEN** the main process receives it and updates internal session state
- **AND** the tray menu is updated accordingly

#### Scenario: HTTP polling removed
- **WHEN** the WebSocket connection is active
- **THEN** no HTTP polling to /api/unread occurs
- **AND** the fetchUnreadCount interval is not started

### Requirement: Topic data cache for display
The main process SHALL maintain a cache of topic metadata (name, color, icon) for use in tray menu and notifications.

#### Scenario: Topic cache populated on startup
- **WHEN** the WebSocket connection is established
- **THEN** the main process fetches GET /api/topics and caches the result

#### Scenario: Topic cache refreshed periodically
- **WHEN** 60 seconds have elapsed since the last topic fetch
- **THEN** the main process re-fetches GET /api/topics to catch any new or renamed topics

#### Scenario: Unknown topic ID falls back gracefully
- **WHEN** an unread update arrives for a topic ID not in the cache
- **THEN** the topic is displayed with its ID as the name
- **AND** a cache refresh is triggered

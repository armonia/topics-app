## ADDED Requirements

### Requirement: Focus messaging is centralized
All WebSocket `{type: "focus"}` messages SHALL originate from a single helper `sendFocusTopic(ws, topicId)` in `client/src/lib/focusMessaging.ts`. No component SHALL construct the focus message payload inline.

#### Scenario: Single focus message per tab switch
- **WHEN** the user activates a chat tab
- **THEN** exactly one `{type: "focus", topicId}` message SHALL be sent to the server

#### Scenario: Blur on non-chat activation
- **WHEN** the active pane becomes a non-chat pane (terminal, browser, etc.)
- **THEN** `{type: "focus", topicId: null}` SHALL be sent to clear server-side focus

### Requirement: Server clears focus on disconnect
On WebSocket close, the server SHALL set `ws.data.focusedTopicId` to `null` (or equivalent "no topic focused" marker) so that reconnecting clients do not inherit stale focus.

#### Scenario: Disconnect clears focus
- **GIVEN** a client has focused topic T and then disconnects
- **WHEN** the server handles the `close` event
- **THEN** `isTopicFocused(T)` for that connection SHALL return false on any stale reference

### Requirement: Unread count logic is deduplicated
The function `updateUnreadCount(topicId, wsRef)` SHALL be the single entry point for incrementing unread counts. No path in `server/routes/topics.ts` SHALL directly mutate SQLite unread without calling this function, EXCEPT the explicit `user_abort` path which intentionally does not increment.

#### Scenario: System-message timeout uses updateUnreadCount
- **WHEN** a system message stream ends via timeout
- **THEN** the code path SHALL call `updateUnreadCount()`
- **AND** SHALL NOT contain inline SQLite UPDATE statements for unread

#### Scenario: user_abort does not increment unread
- **WHEN** a stream ends with `reason: "user_abort"`
- **THEN** the unread count for that topic SHALL NOT change
- **AND** the code SHALL include a comment documenting this intentional behavior

## ADDED Requirements

### Requirement: Out-of-order topic updates never lose tabs
The client SHALL be resilient to WebSocket `topic:*` events arriving in any order relative to the persistence debounced write cycle. No sequence of events SHALL cause an open tab to be silently dropped without the corresponding topic being archived or deleted.

#### Scenario: Rapid rename does not drop tabs
- **GIVEN** a project with 3 open chat tabs
- **WHEN** all 3 topics receive a `topic:updated` rename within 50ms
- **THEN** all 3 tabs SHALL remain open and active selection unchanged

#### Scenario: Interleaved archive and rename
- **GIVEN** 3 open tabs (A, B, C)
- **WHEN** events arrive in order: `rename(A)`, `archive(B)`, `rename(C)`
- **THEN** after all events settle, open tabs SHALL be [A, C] (B removed due to archive only)

### Requirement: Server-persisted state reconciled on topic lifecycle events
When a topic is archived or deleted, the server SHALL remove the topic id from every client's `openChatTopicIds` in ui_state within the same request that archives the topic.

#### Scenario: Archive cleans ui_state
- **WHEN** `POST /api/topics/:id/archive` is called
- **THEN** for every ui_state record containing that id in `openChatTopicIds`
- **THEN** the id SHALL be removed from that list
- **AND** the server SHALL broadcast `ui-state:updated` with the new value

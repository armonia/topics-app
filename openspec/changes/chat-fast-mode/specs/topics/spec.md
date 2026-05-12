## MODIFIED Requirements

### Requirement: Topic persistence schema includes fast mode flag

The `Topic` entity SHALL include an optional `fastMode: boolean` field. The DB schema SHALL include a `fast_mode INTEGER DEFAULT 0 NOT NULL` column on the `topics` table. The migration SHALL be idempotent (no error if the column already exists).

The `PUT /api/topics/:id` endpoint SHALL accept an optional `fastMode: boolean` field in the request body and persist it. When the field changes, the server SHALL broadcast a `topic:updated` WebSocket event so other open windows for the same topic synchronize their local state.

#### Scenario: New topic defaults to fastMode false
- **GIVEN** a fresh topic is created via `POST /api/topics`
- **WHEN** the topic is fetched via `GET /api/topics`
- **THEN** `topic.fastMode` SHALL equal `false`

#### Scenario: PUT updates fastMode and broadcasts
- **GIVEN** an existing topic with `fastMode: false`
- **WHEN** the client posts `PUT /api/topics/:id` with `{ fastMode: true }`
- **THEN** the response SHALL contain `fastMode: true`
- **AND** a `topic:updated` WS event SHALL be broadcast to all connected clients carrying the new `fastMode` value
- **AND** subsequent `GET /api/topics` SHALL return `fastMode: true`

#### Scenario: Migration is idempotent
- **GIVEN** a database where the `fast_mode` column already exists (rerun after upgrade)
- **WHEN** the migration runs at server boot
- **THEN** the migration SHALL detect the existing column via `PRAGMA table_info(topics)` and skip without raising

#### Scenario: Cross-window sync via WS
- **GIVEN** two windows A and B both have the same topic open
- **WHEN** window A toggles Fast mode ON
- **THEN** window A SHALL POST `PUT /api/topics/:id` optimistically
- **AND** window B SHALL receive the `topic:updated` WS event
- **AND** window B's `ChatPane` SHALL re-render with the Fast mode toggle showing ON

#### Scenario: localStorage hydration on mount
- **GIVEN** a user previously toggled Fast mode ON for topic `t1`
- **WHEN** the user reopens the app and `ChatPane` for `t1` mounts
- **THEN** the component SHALL initialize `fastMode` from `localStorage.getItem("fastMode:t1")` synchronously
- **AND** the toggle SHALL render in the ON state without flashing OFF first
- **AND** the subsequent `GET /api/topics` response SHALL confirm the same value (if mismatched, server wins and localStorage is corrected)

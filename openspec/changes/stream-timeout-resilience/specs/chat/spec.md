## ADDED Requirements

### Requirement: Stream inactivity timer is tool-aware

The stream inactivity timer SHALL distinguish between "model silent because stuck" and "model silent because waiting on running tool calls". While at least one tracked tool call is in `running` state, the timer SHALL NOT fire. The timer SHALL be (re-)armed only when:
1. A new event arrives from the provider AND no tool calls are running, OR
2. The last tracked tool call transitions out of `running` (settled or errored).

A separate hard upper-bound (`STREAM_HARD_TIMEOUT_MS`, 30 minutes) SHALL apply unconditionally to protect against leaks.

#### Scenario: Long-running tool does not trigger timeout
- **GIVEN** an assistant message has 1 tool call in `running` state
- **AND** no provider event has arrived for 3 minutes (above the soft timeout)
- **WHEN** the inactivity timer would normally fire
- **THEN** the timer SHALL NOT fire
- **AND** the message SHALL NOT be annotated with `[Response timed out]`

#### Scenario: Hard timeout protects against true hang
- **GIVEN** a stream has been open for 30 minutes with no provider events
- **WHEN** the hard timeout fires
- **THEN** the message SHALL be annotated with `[Hard timeout (30 min) reached]`
- **AND** an activity log entry SHALL be written with `level=error`

### Requirement: Provider emits heartbeat during sub-agent pending

When the claude-code provider has at least one Task() sub-agent parent in non-finished state AND no provider event has occurred for 30 seconds, the provider SHALL emit a `onSubAgentUpdate` event with the last known snapshot for each pending parent. This heartbeat SHALL be idempotent (same snapshot, no UI side effects beyond resetting the route's inactivity timer).

#### Scenario: Sub-agent silent triggers heartbeat
- **GIVEN** a Task() sub-agent has been running for 60 seconds without emitting events
- **WHEN** 30 seconds elapse without any provider event
- **THEN** the provider SHALL emit one `onSubAgentUpdate` per pending parent
- **AND** the snapshot SHALL be identical to the last persisted one

#### Scenario: Heartbeat stops when no parents pending
- **GIVEN** all Task() sub-agents have finished
- **WHEN** the heartbeat interval fires
- **THEN** no events SHALL be emitted
- **AND** the heartbeat interval SHALL be cleared on stream termination

### Requirement: Post-timeout recovery preserves provider output

A soft timeout SHALL NOT immediately finalize the message. Instead, the system SHALL:
1. Mark the message with a "stream slow" annotation (NOT "timed out").
2. Keep the stream handler registered for a 60-second grace period.
3. If a provider event arrives during the grace period, remove the annotation and resume normal streaming.
4. If `onDone` or `onAborted` arrives at any time after the soft timeout, replace the annotated content with the provider's final output.
5. If the grace period expires without events, finalize with `[Response timed out]` and write an activity log entry.

#### Scenario: Provider recovers within grace period
- **GIVEN** the soft timeout fired at T+120s
- **AND** a provider text delta arrives at T+135s
- **WHEN** the delta is processed
- **THEN** the "stream slow" annotation SHALL be removed
- **AND** the streamed content SHALL continue appending normally

#### Scenario: Provider completes after timeout
- **GIVEN** the soft timeout fired and was finalized at T+180s
- **AND** the provider emits `onDone` with full content at T+200s
- **WHEN** the late completion arrives
- **THEN** the message content SHALL be replaced with the provider's final output
- **AND** the annotation SHALL be removed

### Requirement: Stream lifecycle is logged to activity_log

Every stream completion path SHALL write one row to `activity_log`:
- `level=info` on successful `onDone`
- `level=info` on user abort
- `level=warn` on soft inactivity timeout
- `level=error` on hard timeout, provider error, or unrecoverable abort
- `category="stream"` for all stream events
- `metadata` SHALL include sessionKey, durationMs, toolCallCount, subAgentParentCount where applicable

The `activity_log` table SHALL be capped at 10000 most recent rows (older rows deleted on insert when over limit).

#### Scenario: Soft timeout writes warn entry
- **WHEN** the soft inactivity timeout fires for a session
- **THEN** exactly one row SHALL be inserted in `activity_log`
- **AND** the row SHALL have `level="warn"`, `category="stream"`, `title` containing "soft timeout"
- **AND** `metadata` SHALL contain the sessionKey, the elapsed milliseconds, and the count of tracked tool calls

#### Scenario: Successful completion writes info entry
- **WHEN** a stream completes via `onDone`
- **THEN** one `activity_log` row SHALL be written with `level="info"`, `category="stream"`, `title` containing "completed"
- **AND** `metadata` SHALL contain duration and token usage if available

#### Scenario: Activity log respects retention cap
- **GIVEN** `activity_log` contains 10000 rows
- **WHEN** a new row is inserted
- **THEN** the oldest 1 row SHALL be deleted
- **AND** the table count SHALL remain at 10000

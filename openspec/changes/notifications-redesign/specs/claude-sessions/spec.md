# Claude sessions: delta di notifications-redesign

## MODIFIED Requirements

### Requirement: MONITOR-04 — While a Monitor is armed the chat reads as watching, not as finished

A session that ends its turn with background work still in flight is not waiting for the
user: the answer will arrive by itself. The system SHALL track that work per task id,
for every tool that leaves it behind (`Monitor`, `Bash` or `Agent` with
`run_in_background`, `Workflow`, a non-recurring `CronCreate`), and SHALL park the
session in `watching` at `Stop` whenever at least one task is in flight, and in
`awaiting-user` when none is. A task SHALL leave the set when its own completion arrives
(the transcript's `<task-notification>` for that id, the Monitor's delivery or end
including expiry, the cron's first fire or `CronDelete`), not on any wake of the session.
`SessionEnd` and process exit SHALL empty the set. For terminal sessions the set SHALL
survive a server reload.

#### Scenario: Starting a Monitor arms the watch without changing the phase
- **GIVEN** a session with `phase = 'running'`
- **WHEN** a `PreToolUse` hook arrives with `tool_name = 'Monitor'`
- **THEN** `phase = 'tool-running'` as for any other tool
- **AND** the Monitor's task is in the in-flight set

#### Scenario: The end of the turn parks the chat in watching
- **GIVEN** a session that armed a Monitor during the turn
- **WHEN** the tool's `PostToolUse` and then the turn's `Stop` arrive
- **THEN** `phase = 'watching'` rather than `awaiting-user`

#### Scenario: Background Bash, Agent and Workflow park it in watching too
- **GIVEN** a session with `phase = 'running'`
- **WHEN** a `Bash` or an `Agent` with `run_in_background: true`, or a `Workflow`, runs and then `Stop` arrives
- **THEN** `phase = 'watching'`
- **AND** a foreground `Bash` SHALL NOT enter the set, and its `Stop` SHALL give `awaiting-user`

#### Scenario: One of two tasks returns
- **GIVEN** a session in `watching` with two tasks in flight
- **WHEN** the completion of one arrives and the woken turn ends
- **THEN** `phase = 'watching'`, with one task left

#### Scenario: The last task returns
- **GIVEN** a session in `watching` with one task in flight
- **WHEN** its completion arrives and the woken turn ends
- **THEN** `phase = 'awaiting-user'`

#### Scenario: An expired Monitor on a terminal
- **GIVEN** a terminal session in `watching` for one Monitor
- **WHEN** the transcript reports the Monitor expired and the next `Stop` arrives
- **THEN** `phase = 'awaiting-user'`, not `watching`

#### Scenario: A new session does not inherit an old watch
- **GIVEN** a session in `watching`
- **WHEN** a `SessionStart` hook arrives
- **THEN** `phase = 'starting'` and the in-flight set SHALL be empty

#### Scenario: The legacy Monitor hooks keep working
- **GIVEN** a CLI old enough to emit `MonitorArmed` and `MonitorClosed`
- **WHEN** `MonitorArmed` arrives
- **THEN** the phase SHALL move to `watching` with the Monitor in the set
- **AND** `MonitorArmed` SHALL NOT override `awaiting-approval`
- **AND** `MonitorClosed` SHALL remove the Monitor, and from `watching` with an empty set SHALL return to `awaiting-user`

#### Scenario: Watching counts as an active phase, not a resting one
- **GIVEN** the client's phase classification
- **WHEN** `watching` is classified
- **THEN** it SHALL be one of the active phases, beside `running` and `tool-running`

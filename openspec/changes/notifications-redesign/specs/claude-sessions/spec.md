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
`SessionEnd` and process exit SHALL empty the set. The set SHALL survive a server reload
while the process holding it is alive. A session parked in `watching` whose last counting
task a transcript line takes out SHALL go to `awaiting-user`, dated at its `Stop`, once no
task end read since it parked can wake it: each was written before the `Stop` (a notice
absorbed mid-turn that the transcript tail reaches after the hook, one queued while the turn
still answered, an end a reattached terminal reads late or holds through that read), the
CLI's queue let it go undelivered (`remove`), or a minute went by without its delivery. An
end written after the `Stop` and still queued is the report the session waits for: it SHALL
stay `watching` until the row that delivers it wakes the turn.

The set SHALL have one holder, the attention store (`subject_attention.background`): the
phase machine SHALL read from it how many tasks count at `Stop` rather than keep a set of
its own. A recurring `CronCreate` SHALL sit in the set marked recurring, so the chat can
show it, but SHALL NOT count toward `watching`.

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

#### Scenario: A recurring cron does not park it in watching
- **GIVEN** a session with `phase = 'running'`
- **WHEN** a recurring `CronCreate` runs and then `Stop` arrives
- **THEN** `phase = 'awaiting-user'`, with the cron in the set marked recurring

#### Scenario: One of two tasks returns
- **GIVEN** a session in `watching` with two tasks in flight
- **WHEN** the completion of one arrives and the woken turn ends
- **THEN** `phase = 'watching'`, with one task left

#### Scenario: The last task returns
- **GIVEN** a session in `watching` with one task in flight
- **WHEN** its completion arrives and the woken turn ends
- **THEN** `phase = 'awaiting-user'`

#### Scenario: The tail reaches an absorbed notice after the Stop
- **GIVEN** a session whose last task ended mid-turn, its notice absorbed, and whose `Stop` reached the server before the transcript tail read that notice
- **WHEN** the tail reads it
- **THEN** `phase = 'awaiting-user'`, not `watching`
- **AND** the same for a reattached terminal whose turn stopped while the late read still held or had not yet taken out its last tasks

#### Scenario: A notice delivered after the Stop, read in two sweeps
- **GIVEN** a session parked in `watching` on its last task, which ends after the `Stop`
- **WHEN** one sweep of the tail reads the notice's enqueue and the next its delivery row
- **THEN** the phase stays `watching` after the first sweep and is `running` after the second, never `awaiting-user` in between

#### Scenario: The CLI lets a notice go after the Stop
- **GIVEN** a session parked in `watching` on its last task, which ends after the `Stop`
- **WHEN** the CLI's queue lets the notice go without delivering it (`remove`)
- **THEN** `phase = 'awaiting-user'`
- **AND** not while an earlier notice read since the `Stop` still waits to be delivered: that one wakes the turn

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

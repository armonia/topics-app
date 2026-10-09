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
A notice the CLI only queues (`enqueue`) SHALL leave its task in the set until its fate: the
row that delivers it, the queue letting it go undelivered (`remove`: a turn absorbed it, or
it was dropped), or a minute after the turn stopped with neither; while the turn still runs
that minute SHALL NOT start. `SessionEnd` and process exit SHALL empty the set. The set SHALL
survive a server reload while the process holding it is alive. A session parked in
`watching` whose last counting task a transcript line or that minute takes out SHALL go to
`awaiting-user`, dated at its `Stop`: nothing is left to wake it. A hook that fired before the
`Stop` and lands after it SHALL move the phase the same way, dated at the `Stop` too: to
`watching` when it adds a counting task, back to `awaiting-user` when it takes out the last
one, so a line the CLI wrote after the `Stop` still wakes the turn. A notice queued before the
restart of the server SHALL end its task as one of before the restart, wherever its fate is
read.

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

#### Scenario: A notice queued while the turn answers, delivered after the Stop
- **GIVEN** a session whose last task ends while its turn still answers, the notice queued and neither absorbed nor let go
- **WHEN** the `Stop` arrives, before or after the tail reads the enqueue, and the delivery row then wakes the turn
- **THEN** the `Stop` parks the session in `watching`, and `running` follows, never `awaiting-user` in between
- **AND** the attention state announces the two turns once, at the end of the turn the notice woke

#### Scenario: The CLI lets a notice go after the Stop
- **GIVEN** a session parked in `watching` on its last task, which ends after the `Stop`
- **WHEN** the CLI's queue lets the notice go without delivering it (`remove`)
- **THEN** `phase = 'awaiting-user'`
- **AND** not while an earlier notice queued and still undelivered holds its task: that one wakes the turn

#### Scenario: A notice the CLI neither delivers nor lets go
- **GIVEN** a session whose last task's notice is queued and then neither delivered nor let go
- **WHEN** a minute passes after the `Stop`
- **THEN** the task leaves the set and `phase = 'awaiting-user'`
- **AND** not while the turn still runs: the CLI may absorb the notice at its next tool call

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

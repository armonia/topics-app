## ADDED Requirements

### Requirement: SCHED-01 — One schedule engine inside Topics
Topics SHALL run every scheduled job through one engine. A job has a schedule (`cron` with a zone, `every` N minutes, or `at` one instant) and an action; board recurrences are jobs with the `card` action.

#### Scenario: A board recurrence fires through the engine
- **WHEN** a `card` job is due at a tick
- **THEN** one run row is written and the card is created in the same transaction

### Requirement: SCHED-02 — An occurrence starts once
An occurrence SHALL be identified by its UTC instant, and a run SHALL move from `pending` to `starting` only through a conditional update, so two ticks, a restart or two servers on one database start it once.

#### Scenario: Two engines on one database
- **WHEN** both engines tick on the same due occurrence
- **THEN** exactly one run exists and the action launches once

#### Scenario: The repeated hour of a clock change
- **WHEN** the clocks go back and a cron time happens twice
- **THEN** only the first pass runs

### Requirement: SCHED-03 — Lost occurrences are counted, not replayed
The engine SHALL run at most one lost occurrence per job within the window of its action, and record the others as one `missed` run with a count and a cause. `every` jobs SHALL advance from the scheduled instant, never from the start of the run.

#### Scenario: Three hours of downtime
- **WHEN** an `every 10` job was due during three hours of downtime
- **THEN** it runs once and one `missed` row carries the count

### Requirement: SCHED-04 — Shutdown stops the engine first
The engine timer SHALL be the first thing stopped by the graceful shutdown, and no run SHALL start after it.

#### Scenario: Shutdown begins
- **WHEN** the shutdown starts
- **THEN** a later tick starts nothing

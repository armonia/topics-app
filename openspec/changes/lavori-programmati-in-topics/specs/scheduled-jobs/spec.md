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

### Requirement: SCHED-05: One adapter carries an outcome out of the app
The outcome of a job SHALL leave the app through ONE adapter: a command given as an argument list plus environment variables, with the placeholders `{channel} {chat} {thread} {title} {jobId} {runId} {key}`, the text on stdin, an argument that stays empty taking its option with it, and the executable resolved to an absolute path. The adapter is an app setting with a fallback on `TOPICS_OWNER_ALERT_COMMAND`, and it is empty by default: with none, nothing leaves and the run says it was not delivered. The code SHALL name no service, channel or person. With no setting, the variable IS the delivery to the owner and of the alerts; an explicit destination whose adapter has no `{channel}`, `{chat}` or `{thread}` placeholder SHALL be refused with an error that says so. A text that ends with `NO_REPLY` on its last line says nothing. Only runs that finished after the job got its `deliver` block are sent, and none of a job waiting for its owner.

#### Scenario: What goes out
- **WHEN** a command finishes with stdout "report" and stderr "noise"
- **THEN** the adapter is called once with "report" on stdin and the run id as the key, and "noise" goes nowhere

#### Scenario: Nothing to say
- **WHEN** stdout is empty or `NO_REPLY`
- **THEN** no process is started

### Requirement: SCHED-06: A delivery happens once
Before the adapter is called the delivery SHALL be written as `delivering` under a key the caller gives. A try SHALL be repeated only when the adapter exits non-zero, three times at most, then `delivery_failed`; a call that went over its time limit, left a pipe open or ended by a signal SHALL close as `unknown` at once, because it may have gone out. A delivery found `delivering` at boot SHALL become `unknown` and SHALL never be started again by itself. The register is shared: a mail send uses the same key rule and the same `unknown` outcome.

#### Scenario: A restart between the send and its record
- **WHEN** the server stops after the adapter received the text and before the answer was written
- **THEN** after the restart the delivery is `unknown` and the adapter is not called again

### Requirement: SCHED-07: Three failures in a row tell the owner, once a day
A job whose last three counted runs (`error`, `timeout`, `failed_to_start`) are all errors SHALL raise one alert per day, held back in the quiet hours and raised in the morning. `skipped`, `missed`, `interrupted` and `cancelled` SHALL NOT touch the series. The alert SHALL be a row of the bell under the subject `job:<id>`, which enters the unseen count, and SHALL light the subject `job:<id>` until seen, in the failures group of the bell, the Dock and the tray. A job already paused raises none, and a quiet-hours zone that is not valid is ignored with a log line. It SHALL be raised through a reusable door (subject, anti-duplicate scope, quiet hours) that other features, such as mail arrival, also call.

#### Scenario: The third failure
- **WHEN** a job ends in error three times in a row
- **THEN** one row with the subject `job:<id>` is on the bell and counts, and a fourth failure the same day adds none

### Requirement: SCHED-08: Agents can manage jobs, and a job they make waits for the person
Agents SHALL have tools to create, list, run, pause and delete jobs, and none to turn one on. With the app setting `ask` (the default) a job an agent creates SHALL be born paused and the person told on the bell; with `auto` only a job with a delivery is. A job an agent made stays waiting for the owner until a person turns it on: until then neither run-now nor the engine starts it and nothing of it is delivered. A one-time job created with an instant in the past is refused. This is a speed bump, not a security boundary: an agent already has a shell.

#### Scenario: An agent creates a job with a delivery
- **WHEN** an agent creates a job with a `deliver` block, whatever the setting
- **THEN** the job exists paused and nothing runs until the person turns it on

### Relation to OUTBOUND-03 (human confirmation for mail and Google)
OUTBOUND-03 asks a person to say yes to EACH message sent as mail or written to Google, and that stays: a job's delivery is not a mail and is not on that door. The person's yes for a delivery is given once, in two places that only they control: they write the adapter and the owner destination in the app settings, and they turn on any job an agent made. After that each run sends to that one destination and to no other, which is why a `deliver` block can name `owner` or a destination but an agent cannot widen where the adapter points. An adapter MUST NOT be used to send mail: that goes through `send_mail` and its per-message confirmation.

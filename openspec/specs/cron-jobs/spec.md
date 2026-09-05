# cron-jobs Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: CRON-01 — Job Management

The system SHALL provide a cron jobs panel in the sidebar that lists scheduled jobs, supports enabling/disabling individual jobs, allows immediate execution, provides job deletion with confirmation, displays schedule information in human-readable format, and auto-refreshes the job list periodically.

#### Scenario: Cron jobs panel loads and displays enabled jobs
- **GIVEN** the cron jobs panel is visible in the sidebar
- **WHEN** the panel mounts with the enabled prop set to true
- **THEN** the system SHALL fetch jobs from GET /api/cron/jobs
- **AND** enabled jobs SHALL be displayed in the main list with their name, schedule, and next run time

#### Scenario: Disabled jobs are shown in a collapsed section
- **GIVEN** the job list contains both enabled and disabled jobs
- **WHEN** the panel renders the job list
- **THEN** disabled jobs SHALL be grouped under a collapsible "N disabled" section
- **AND** the section SHALL be collapsed by default with reduced opacity

#### Scenario: Job displays "at" schedule type with formatted date
- **GIVEN** a cron job has a schedule with kind "at" and an atMs timestamp
- **WHEN** the job row renders
- **THEN** the schedule SHALL display as a formatted date (e.g., "Mar 15, 02:30 PM")
- **AND** a Calendar icon SHALL appear next to the schedule text

#### Scenario: Job displays "every" schedule type with interval
- **GIVEN** a cron job has a schedule with kind "every" and an everyMs interval
- **WHEN** the job row renders
- **THEN** the schedule SHALL display as a human-readable interval (e.g., "every 5m", "every 2h", "every 1d")
- **AND** a RefreshCw icon SHALL appear next to the schedule text

#### Scenario: Job displays "cron" schedule type with expression
- **GIVEN** a cron job has a schedule with kind "cron" and an expr string
- **WHEN** the job row renders
- **THEN** the schedule SHALL display the raw cron expression
- **AND** a Clock icon SHALL appear next to the schedule text

#### Scenario: Job displays next run countdown for enabled jobs
- **GIVEN** an enabled cron job has a nextRunAt timestamp
- **WHEN** the job row renders
- **THEN** the next run time SHALL be displayed as a relative countdown (e.g., "30s", "5m", "2h")
- **AND** jobs with past nextRunAt SHALL display "now"

#### Scenario: Job name falls back to payload text when unnamed
- **GIVEN** a cron job has no explicit name
- **WHEN** the job row renders
- **THEN** the display name SHALL fall back to the first 30 characters of payload.text or payload.message
- **AND** if neither exists, the name SHALL default to "Job"

#### Scenario: User enables a disabled job
- **GIVEN** a disabled cron job is visible in the disabled section
- **WHEN** the user clicks the Pause icon toggle button on the job row
- **THEN** the system SHALL send a PATCH request to /api/cron/jobs/:id with { enabled: true }
- **AND** the job SHALL move from the disabled section to the enabled list

#### Scenario: User disables an enabled job
- **GIVEN** an enabled cron job is visible in the main list
- **WHEN** the user clicks the Zap icon toggle button on the job row
- **THEN** the system SHALL send a PATCH request to /api/cron/jobs/:id with { enabled: false }
- **AND** the job SHALL move from the enabled list to the disabled section

#### Scenario: User triggers immediate job execution
- **GIVEN** a cron job row is hovered to reveal action buttons
- **WHEN** the user clicks the Play button on the job row
- **THEN** the system SHALL send a POST request to /api/cron/jobs/:id/run
- **AND** the job list SHALL refresh after 1 second to update lastRunAt

#### Scenario: User deletes a cron job with confirmation
- **GIVEN** a cron job row is hovered to reveal action buttons
- **WHEN** the user clicks the Trash button on the job row
- **THEN** a browser confirmation dialog SHALL appear asking "Delete this job?"
- **AND** upon confirmation, the system SHALL send a DELETE request to /api/cron/jobs/:id

#### Scenario: Deleted job is removed from the list immediately
- **GIVEN** the user has confirmed deletion of a cron job
- **WHEN** the DELETE request returns successfully
- **THEN** the job SHALL be removed from the displayed list without a full refresh

#### Scenario: Job action buttons appear on hover
- **GIVEN** a cron job row is displayed in the panel
- **WHEN** the user hovers the mouse over the job row
- **THEN** Play (run now) and Trash (delete) buttons SHALL appear on the right side of the row
- **AND** the buttons SHALL disappear when the mouse leaves the row

#### Scenario: Panel auto-refreshes every 30 seconds
- **GIVEN** the cron jobs panel is mounted and enabled
- **WHEN** 30 seconds elapse since the last refresh
- **THEN** the system SHALL automatically fetch the latest job list from GET /api/cron/jobs

#### Scenario: User manually refreshes the job list
- **GIVEN** the cron jobs panel is visible
- **WHEN** the user clicks the Refresh button at the bottom of the panel
- **THEN** the system SHALL fetch the latest job list from the server
- **AND** the RefreshCw icon SHALL animate (spin) while loading

#### Scenario: Empty state displays when no jobs exist
- **GIVEN** the server returns an empty jobs array
- **WHEN** the panel finishes loading
- **THEN** the panel SHALL display "No cron jobs" centered text

#### Scenario: Error state displays when fetch fails
- **GIVEN** the server is unreachable or returns an error
- **WHEN** the panel attempts to load jobs
- **THEN** the panel SHALL display "Failed to load" in red text

#### Scenario: Panel does not fetch when disabled
- **GIVEN** the cron jobs panel is rendered with enabled prop set to false
- **WHEN** the component mounts
- **THEN** the system SHALL NOT send any requests to the cron jobs API
- **AND** the auto-refresh interval SHALL NOT be started


### Requirement: CRONUI-01 — I tre comandi di riga rispondono sullo schermo

Accendere, eseguire e cancellare un job finivano tutti e tre in un
`console.error`: su un rifiuto l'icona restava dov'era, la riga non si muoveva,
e l'unica traccia era in una console che nessuno ha aperta. Chi ha premuto non
poteva distinguere «è andata» da «il server ha detto di no», e le due mosse
successive sono opposte.

Un comando rifiutato SHALL lasciare sul pannello una superficie d'errore
visibile, con la frase che il server ha mandato quando c'è.

#### Scenario: la rotta di esecuzione rifiuta
- **GIVEN** un job in elenco e la rotta `run` che risponde con un errore
- **WHEN** si preme «Esegui adesso»
- **THEN** SHALL comparire la banda d'errore del pannello

### Requirement: CRONUI-01b — Un'esecuzione riuscita lascia un segno sulla riga

`lastRunAt` arrivava dal server e veniva buttato via: la riga non aveva nessuno
stato «eseguito», quindi un Play riuscito e un Play rifiutato lasciavano la
stessa riga identica. È l'altra metà di CRONUI-01: senza un segno per il
successo, l'assenza di segno non può significare fallimento.

La riga di un job eseguito SHALL dire che è stato eseguito, e SHALL dirlo subito
dopo il gesto e non al giro di aggiornamento successivo.

#### Scenario: l'esecuzione riesce
- **GIVEN** un job senza esecuzioni precedenti e la rotta `run` che accetta
- **WHEN** si preme «Esegui adesso»
- **THEN** la riga SHALL mostrare che il job è stato eseguito

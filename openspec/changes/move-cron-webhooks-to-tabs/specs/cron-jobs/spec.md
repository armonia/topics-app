## MODIFIED Requirements

### Requirement: CRON-01 — Job Management

The system SHALL provide a cron jobs panel accessible from the Topics dropdown menu that opens as a full pane tab, lists scheduled jobs, supports enabling/disabling individual jobs, allows immediate execution, provides job deletion with confirmation, displays schedule information in human-readable format, and auto-refreshes the job list periodically.

#### Scenario: Cron Jobs appears in Topics dropdown menu
- **WHEN** the user opens the Topics dropdown menu
- **THEN** a "Cron Jobs" menu item SHALL appear with a Timer icon
- **AND** clicking it SHALL open a cron jobs pane tab via handleOpenAsPage

#### Scenario: Cron Jobs opens as a pane tab
- **WHEN** the user clicks "Cron Jobs" in the Topics menu
- **THEN** a pane with ID `__cron__` SHALL be added to openPanels
- **AND** the pane SHALL render the CronJobsPanel component as embedded content
- **AND** the panel SHALL be always enabled (fetch on mount, not conditional)

#### Scenario: Cron jobs panel loads and displays enabled jobs
- **GIVEN** the cron jobs pane is open
- **WHEN** the panel mounts
- **THEN** the system SHALL fetch jobs from GET /api/cron/jobs
- **AND** enabled jobs SHALL be displayed in the main list with their name, schedule, and next run time

#### Scenario: Cron Jobs icon button is removed from sidebar header
- **WHEN** the sidebar header renders
- **THEN** no Timer icon button for Cron Jobs SHALL be present in the header icon row
- **AND** no dropdown portal SHALL render for CronJobsPanel

#### Scenario: Panel auto-refreshes every 30 seconds
- **GIVEN** the cron jobs pane is open
- **WHEN** 30 seconds elapse since the last refresh
- **THEN** the system SHALL automatically fetch the latest job list from GET /api/cron/jobs

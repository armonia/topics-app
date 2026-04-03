## MODIFIED Requirements

### Requirement: LAYOUT-UTILITY — Utility Panel Types

The layout system SHALL support opening utility panels as pane tabs, including activity, agents, dashboard, all-boards, journal, and cron types.

#### Scenario: handleOpenAsPage accepts cron type
- **WHEN** `handleOpenAsPage('cron')` is called
- **THEN** a pane with ID `__cron__` SHALL be added to openPanels
- **AND** the pane SHALL be focused

#### Scenario: UtilityPanel renders CronJobsPanel for cron type
- **WHEN** a UtilityPanel of type `cron` renders
- **THEN** it SHALL display the CronJobsPanel component with embedded styling

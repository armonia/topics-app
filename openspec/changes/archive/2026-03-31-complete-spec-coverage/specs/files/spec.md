## ADDED Requirements

### Requirement: FILE-03 — Process & Script Runner

The system SHALL list scripts from the project's package.json, allow starting and stopping script execution with live status indicators, display running process information with session details, support spawning new agents via a dialog, and show port links for running scripts.

#### Scenario: Script runner lists scripts from package.json
- **GIVEN** the project folder contains a package.json with defined scripts
- **WHEN** the script runner component loads
- **THEN** each script name from the package.json is displayed as a clickable row
- **AND** a Play icon appears next to each idle script name

#### Scenario: Script names are color-coded by type
- **GIVEN** scripts are listed in the script runner
- **WHEN** the user views the script names
- **THEN** dev/start/serve scripts display with green icon color
- **AND** build/compile scripts display with blue icon color
- **AND** test/spec/e2e scripts display with yellow icon color
- **AND** lint/format scripts display with purple icon color

#### Scenario: Clicking an idle script starts execution
- **GIVEN** a script is in idle state with a Play icon
- **WHEN** the user clicks the script row
- **THEN** the Play icon changes to a spinning indicator
- **AND** the script name styling changes to indicate starting state

#### Scenario: Running script shows green pulsing indicator
- **GIVEN** a script has been started and is actively running
- **WHEN** the script runner refreshes its state
- **THEN** the script row shows a green pulsing dot indicator
- **AND** the script name appears in green with bold styling

#### Scenario: Stop button appears on running script hover
- **GIVEN** a script is running with a green pulsing indicator
- **WHEN** the user hovers over the script row
- **THEN** a Stop (square) button becomes visible on the right side of the row
- **AND** clicking the Stop button initiates script termination

#### Scenario: Stopping a script shows termination indicator
- **GIVEN** a running script exists in the script runner
- **WHEN** the user clicks the Stop button
- **THEN** a red spinning indicator replaces the green dot
- **AND** the script name shows in a faded red style
- **AND** the row becomes non-interactive until termination completes

#### Scenario: Running script shows port links
- **GIVEN** a running script has detected open ports
- **WHEN** the script row is displayed
- **THEN** port number links appear inline (e.g., ":3333")
- **AND** each port link opens in a new browser tab when clicked

#### Scenario: Hovering idle script shows command preview
- **GIVEN** an idle script is listed in the script runner
- **WHEN** the user hovers over the script row
- **THEN** the underlying npm command text appears on the right side of the row

#### Scenario: Script runner returns null when no scripts exist
- **GIVEN** the project package.json has no scripts defined
- **WHEN** the script runner component renders
- **THEN** the component renders nothing (no script list visible)

#### Scenario: Clicking a running script opens process log
- **GIVEN** a script is running with an active process
- **WHEN** the user clicks the running script row
- **THEN** the onOpenProcessLog callback is invoked with the process ID and script name

#### Scenario: Process list displays running and completed processes
- **GIVEN** a topic has spawned sub-agent processes
- **WHEN** the process list loads
- **THEN** each process row shows a status icon, label, and duration
- **AND** running processes show a running indicator with "(running)" suffix
- **AND** completed processes show a checkmark icon

#### Scenario: Process list empty state shows launch prompt
- **GIVEN** no sub-processes exist for the current topic
- **WHEN** the process list renders
- **THEN** a "No sub-processes" message is displayed
- **AND** a "Launch Agent" button is visible below the message

#### Scenario: Stop button on process terminates the agent
- **GIVEN** a running process is displayed in the process list
- **WHEN** the user clicks the Stop (square) button on the process row
- **THEN** the button enters a disabled state while stopping
- **AND** the process list refreshes after a brief delay

#### Scenario: Expanding a process row shows session details
- **GIVEN** a process row is visible in the process list
- **WHEN** the user clicks the process row
- **THEN** an expanded section appears showing the session key and start timestamp
- **AND** completed processes also show the completion timestamp

#### Scenario: New Agent dialog opens from plus button
- **GIVEN** the process list header is visible
- **WHEN** the user clicks the Plus (+) button in the header
- **THEN** a "New Agent" spawn dialog overlay appears
- **AND** the dialog contains Task, Label, and Model fields

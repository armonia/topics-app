## ADDED Requirements

### Requirement: PROCESS-01 — Script Execution

The system SHALL provide script management capabilities including listing package.json scripts, starting scripts as background processes, stopping running processes, streaming live output with log persistence, detecting listening ports per process, and displaying script status with real-time WebSocket updates.

#### Scenario: Script runner loads scripts from package.json
- **GIVEN** a project sidebar is open for a topic with a linked project folder
- **WHEN** the ScriptRunner component mounts
- **THEN** the system SHALL fetch package.json scripts via the files API
- **AND** each script SHALL be displayed as a row with its name and a Play icon

#### Scenario: Script names are color-coded by category
- **GIVEN** scripts are loaded from package.json
- **WHEN** the script list renders
- **THEN** scripts matching "dev", "start", or "serve" SHALL have green icons
- **AND** scripts matching "build" or "compile" SHALL have blue icons
- **AND** scripts matching "test", "spec", or "e2e" SHALL have yellow icons
- **AND** scripts matching "lint", "format", or "prettier" SHALL have purple icons

#### Scenario: User starts a script
- **GIVEN** a script is listed and not currently running
- **WHEN** the user clicks on the script row
- **THEN** the system SHALL send a POST request to /api/scripts/run with projectPath and scriptName
- **AND** a spinning indicator SHALL appear next to the script name while starting

#### Scenario: Running script shows green pulse indicator
- **GIVEN** a script has been started and is currently running
- **WHEN** the script list renders
- **THEN** the script row SHALL display a green pulsing dot instead of the Play icon
- **AND** the script name SHALL appear in green bold text

#### Scenario: Running script displays listening ports
- **GIVEN** a script is running and has child processes listening on TCP ports
- **WHEN** the script list renders
- **THEN** the detected ports SHALL be displayed as clickable links (e.g., ":3000", ":5173")
- **AND** clicking a port link SHALL open the URL in a new browser tab

#### Scenario: User stops a running script
- **GIVEN** a script is currently running with a visible Stop button
- **WHEN** the user clicks the Square (stop) button on the script row
- **THEN** the system SHALL send a POST request to /api/scripts/:id/stop
- **AND** a red spinning indicator SHALL appear while the process is stopping
- **AND** the system SHALL poll until the process is confirmed stopped

#### Scenario: Server kills process with SIGTERM then SIGKILL fallback
- **GIVEN** a running script has been requested to stop
- **WHEN** the stop endpoint is called
- **THEN** the server SHALL send SIGTERM to the process group
- **AND** if the process is still alive after 5 seconds, SIGKILL SHALL be sent

#### Scenario: User clicks a running script to view its log
- **GIVEN** a script is currently running
- **WHEN** the user clicks on the script row (not the stop button)
- **THEN** the onOpenProcessLog callback SHALL be invoked with the processId and script name

#### Scenario: Script command tooltip displays on hover
- **GIVEN** a script is not currently running
- **WHEN** the user hovers over the script row
- **THEN** the full npm command SHALL appear as a tooltip and as truncated detail text

#### Scenario: Process list shows all sub-processes for a topic
- **GIVEN** a topic has spawned one or more agent sub-processes
- **WHEN** the ProcessList component mounts with the topicId
- **THEN** the system SHALL fetch processes from the processes API
- **AND** each process SHALL display with a status icon, label, and duration

#### Scenario: Process status icons indicate running, done, or error states
- **GIVEN** processes are loaded for a topic
- **WHEN** the process list renders
- **THEN** running processes SHALL show a spinning icon
- **AND** completed processes SHALL show a check icon
- **AND** errored processes SHALL show an error icon

#### Scenario: User expands a process to view details
- **GIVEN** the process list displays one or more processes
- **WHEN** the user clicks on a process row
- **THEN** the row SHALL expand to show the session key, start time, and completion time if available

#### Scenario: User stops a running agent process
- **GIVEN** a process is in the running state
- **WHEN** the user clicks the Square (stop) button on the process row
- **THEN** the system SHALL send a POST request to /api/agents/sessions/:key/stop
- **AND** the process list SHALL refresh after 1 second

#### Scenario: User spawns a new agent from the process list
- **GIVEN** the process list is visible
- **WHEN** the user clicks the Plus button in the header or the "Launch Agent" button
- **THEN** a spawn dialog SHALL appear with fields for Task (required), Label (optional), and Model (optional)

#### Scenario: Agent spawn dialog submits to the API
- **GIVEN** the spawn dialog is open with a task description entered
- **WHEN** the user clicks the Launch button
- **THEN** the system SHALL send a POST request to /api/agents/spawn with topicId, task, label, and model
- **AND** the dialog SHALL close and the process list SHALL refresh after 1 second

#### Scenario: Process list auto-refreshes every 10 seconds
- **GIVEN** the process list is mounted
- **WHEN** 10 seconds elapse since the last refresh
- **THEN** the system SHALL automatically fetch the latest process list

#### Scenario: Script output is streamed and persisted to log files
- **GIVEN** a script is running on the server
- **WHEN** the process writes to stdout or stderr
- **THEN** the output SHALL be captured in a circular buffer (max 500KB per process)
- **AND** the output SHALL be persisted to a log file in .state/scripts/

#### Scenario: Script output can be fetched with offset pagination
- **GIVEN** a script has produced output
- **WHEN** a GET request is sent to /api/scripts/:id/output with an offset parameter
- **THEN** the server SHALL return only lines after the specified offset
- **AND** the response SHALL include the current total offset, done status, and exit code

#### Scenario: Server broadcasts script state changes via WebSocket
- **GIVEN** a script starts, produces output, or completes
- **WHEN** the state changes
- **THEN** the server SHALL broadcast a "scripts:updated" event to all WebSocket clients
- **AND** output notifications SHALL be debounced to at most 1 per second

#### Scenario: Server re-adopts running processes after restart
- **GIVEN** scripts were running before a server restart
- **WHEN** the server starts and loads persisted state from .state/scripts.json
- **THEN** processes with PIDs still alive SHALL be re-tracked as running
- **AND** processes with dead PIDs SHALL be marked as error with exitCode -1

#### Scenario: Empty process list shows launch prompt
- **GIVEN** a topic has no sub-processes
- **WHEN** the process list renders
- **THEN** a "No sub-processes" message SHALL display with a "Launch Agent" button

#### Scenario: Script list returns empty when no package.json scripts exist
- **GIVEN** the project has no scripts in package.json
- **WHEN** the ScriptRunner component mounts
- **THEN** the component SHALL render nothing (return null)

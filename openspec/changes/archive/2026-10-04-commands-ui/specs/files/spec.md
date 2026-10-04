# Files: Mostra nel Finder solo dove c'è il Finder

## MODIFIED Requirements

### Requirement: FILE-03 — Reveal in Finder

The system SHALL allow users to reveal any file or folder in macOS Finder directly from the file tree context menu.

The reveal runs on the SERVER (`open -R`), so the option SHALL be offered only where
it shows something to the person who clicked: in the desktop shell connected to a
server on the same machine (loopback). From a phone, a browser on another computer
or a LAN client the option SHALL NOT be shown. A reveal that fails SHALL say so.

#### Scenario: Context menu shows "Show in Finder" option for a file
- **GIVEN** the desktop shell on the machine that runs the server, and a file visible in the file tree
- **WHEN** the user right-clicks on the file
- **THEN** the context menu SHALL include a "Show in Finder" option

#### Scenario: Context menu shows "Show in Finder" option for a folder
- **GIVEN** the desktop shell on the machine that runs the server, and a directory visible in the file tree
- **WHEN** the user right-clicks on the directory
- **THEN** the context menu SHALL include a "Show in Finder" option

#### Scenario: Clicking "Show in Finder" reveals the file in Finder
- **GIVEN** the context menu is open on a file
- **WHEN** the user selects "Show in Finder"
- **THEN** the system SHALL open macOS Finder with the file selected and highlighted

#### Scenario: Clicking "Show in Finder" reveals the folder in Finder
- **GIVEN** the context menu is open on a directory
- **WHEN** the user selects "Show in Finder"
- **THEN** the system SHALL open macOS Finder with the directory selected and highlighted

#### Scenario: Not offered away from the server's machine
- **GIVEN** a web client that is not the desktop shell on a loopback server
- **WHEN** the user right-clicks on a file
- **THEN** the context menu SHALL NOT include a "Show in Finder" option

#### Scenario: A failed reveal says so
- **GIVEN** the reveal answers with an error
- **WHEN** the user selects "Show in Finder"
- **THEN** a message SHALL say the file could not be shown

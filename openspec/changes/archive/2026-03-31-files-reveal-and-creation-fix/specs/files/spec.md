## ADDED Requirements

### Requirement: FILE-03 — Reveal in Finder

The system SHALL allow users to reveal any file or folder in macOS Finder directly from the file tree context menu.

#### Scenario: Context menu shows "Show in Finder" option for a file
- **WHEN** the user right-clicks on a file in the file tree
- **THEN** the context menu SHALL include a "Show in Finder" option

#### Scenario: Context menu shows "Show in Finder" option for a folder
- **WHEN** the user right-clicks on a directory in the file tree
- **THEN** the context menu SHALL include a "Show in Finder" option

#### Scenario: Clicking "Show in Finder" reveals the file in Finder
- **WHEN** the user selects "Show in Finder" from the context menu on a file
- **THEN** the system SHALL open macOS Finder with the file selected and highlighted

#### Scenario: Clicking "Show in Finder" reveals the folder in Finder
- **WHEN** the user selects "Show in Finder" from the context menu on a directory
- **THEN** the system SHALL open macOS Finder with the directory selected and highlighted

## MODIFIED Requirements

### Requirement: FILE-01 — Explorer Tree, File CRUD & Editor

The system SHALL support browsing files in a hierarchical tree, opening files in an editor with tabs, searching across files, navigating via breadcrumbs, running scripts, and managing processes.

#### Scenario: Header "New File" button creates a file at the project root
- **WHEN** the user clicks the "New File" button in the Files panel header
- **THEN** an inline text input SHALL appear at the top of the file tree
- **AND** after the user types a name and presses Enter, a new file SHALL be created in the project root directory

#### Scenario: Header "New Folder" button creates a folder at the project root
- **WHEN** the user clicks the "New Folder" button in the Files panel header
- **THEN** an inline text input SHALL appear at the top of the file tree
- **AND** after the user types a name and presses Enter, a new directory SHALL be created in the project root directory

#### Scenario: Sidebar toolbar "New File" button creates a file at the project root
- **WHEN** the user clicks the "New File" button in the sidebar toolbar
- **THEN** an inline text input SHALL appear at the top of the file tree
- **AND** after the user types a name and presses Enter, a new file SHALL be created in the project root directory

#### Scenario: Sidebar toolbar "New Folder" button creates a folder at the project root
- **WHEN** the user clicks the "New Folder" button in the sidebar toolbar
- **THEN** an inline text input SHALL appear at the top of the file tree
- **AND** after the user types a name and presses Enter, a new directory SHALL be created in the project root directory

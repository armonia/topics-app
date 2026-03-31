## Purpose

Specifies behavioral scenarios for file explorer tree navigation, file editing and tabs, file search, breadcrumb navigation, script runner, process management, git status indicators, diff viewer, and version control operations.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic exists with a linked project folder containing files and a git repository
- The file explorer pane is visible in the layout

## Requirements

### Requirement: FILE-01 — Explorer Tree, File CRUD & Editor

The system SHALL support browsing files in a hierarchical tree, opening files in an editor with tabs, searching across files, navigating via breadcrumbs, running scripts, and managing processes.

#### Scenario: File tree renders hierarchical directory and file structure
- **GIVEN** a topic has a linked project folder with files and subdirectories
- **WHEN** the file explorer pane loads
- **THEN** the file tree displays root-level files and directories
- **AND** subdirectories are shown as expandable nodes

#### Scenario: Expand directory node to reveal nested files
- **GIVEN** the file tree shows a collapsed directory node
- **WHEN** the user clicks on the directory node
- **THEN** the directory expands to reveal its child files and subdirectories

#### Scenario: Collapse expanded directory node
- **GIVEN** a directory node is currently expanded in the file tree
- **WHEN** the user clicks on the expanded directory node
- **THEN** the directory collapses and its children are hidden

#### Scenario: Clicking a file opens it in the editor pane
- **GIVEN** a file is visible in the file tree
- **WHEN** the user clicks on the file
- **THEN** the file opens in the editor pane
- **AND** a tab appears in the tab bar showing the filename
- **AND** the breadcrumb navigation shows the file path

#### Scenario: Editor displays code content with syntax highlighting
- **GIVEN** a source code file has been opened in the editor
- **WHEN** the editor pane renders
- **THEN** the file content is displayed with syntax-appropriate highlighting
- **AND** whitespace and formatting are preserved

#### Scenario: Single-click opens file as preview tab
- **GIVEN** no file is currently open in the editor
- **WHEN** the user single-clicks a file in the tree
- **THEN** the file opens as a preview tab indicated by italic text
- **AND** opening another file replaces the preview tab

#### Scenario: Double-click pins a preview tab
- **GIVEN** a file is open as a preview tab with italic styling
- **WHEN** the user double-clicks on the tab
- **THEN** the tab becomes pinned and the italic styling is removed
- **AND** opening another file creates a new preview tab instead of replacing the pinned one

#### Scenario: Multiple editor tabs open simultaneously
- **GIVEN** one file is already pinned in the editor
- **WHEN** the user clicks a second file in the tree
- **THEN** both files appear as separate tabs in the tab bar
- **AND** the user can see both tab labels

#### Scenario: Switching between editor tabs shows correct content
- **GIVEN** two or more files are open in separate tabs
- **WHEN** the user clicks on a different tab
- **THEN** the editor displays the content of the selected file
- **AND** the breadcrumb navigation updates to show the selected file path

#### Scenario: Closing an editor tab removes it from the tab bar
- **GIVEN** multiple files are open in the tab bar
- **WHEN** the user hovers over a tab and clicks the close button
- **THEN** the tab is removed from the tab bar
- **AND** the editor switches to the next available tab

#### Scenario: File search opens with keyboard shortcut
- **GIVEN** the file explorer pane is active
- **WHEN** the user presses Cmd+Shift+F
- **THEN** a file search panel opens with a text input field

#### Scenario: File search returns matching results
- **GIVEN** the file search panel is open
- **WHEN** the user types a search query that matches content in project files
- **THEN** search results appear listing files and matching lines
- **AND** each result shows the filename and matched text

#### Scenario: Selecting a search result opens the file
- **GIVEN** file search results are displayed
- **WHEN** the user selects a result using keyboard navigation and presses Enter
- **THEN** the corresponding file opens in the editor
- **AND** the file search panel closes

#### Scenario: Invalid regex in file search shows error feedback
- **GIVEN** the file search panel is open with regex mode enabled
- **WHEN** the user enters an invalid regex pattern
- **THEN** an error indicator appears below the search input
- **AND** no results are displayed
- **AND** the search panel remains functional

#### Scenario: Valid regex clears previous error feedback
- **GIVEN** an invalid regex error is displayed in file search
- **WHEN** the user replaces the pattern with a valid search query
- **THEN** the error indicator disappears
- **AND** matching results appear normally

#### Scenario: Breadcrumb navigation shows current file path
- **GIVEN** a nested file is open in the editor
- **WHEN** the breadcrumb bar renders
- **THEN** each directory segment of the file path is shown as a clickable element
- **AND** the filename appears as the final breadcrumb segment

#### Scenario: Clicking breadcrumb segment opens directory dropdown
- **GIVEN** a breadcrumb navigation bar is showing a file path
- **WHEN** the user clicks on a directory segment in the breadcrumb
- **THEN** a dropdown appears listing sibling files and directories at that level

#### Scenario: Breadcrumb dropdown refreshes when navigating to a different directory
- **GIVEN** a breadcrumb dropdown was previously opened for one directory
- **WHEN** the user opens a file in a different directory and clicks a breadcrumb segment
- **THEN** the dropdown shows the contents of the new directory
- **AND** does not display stale content from the previous directory

#### Scenario: Rapid file opens resolve to the correct final content
- **GIVEN** the file tree is visible with multiple files
- **WHEN** the user clicks several files in quick succession
- **THEN** the editor settles on displaying the content of the last file clicked
- **AND** the breadcrumb and tab reflect the last file opened

#### Scenario: Script runner lists scripts from package.json
- **GIVEN** the project folder contains a package.json with defined scripts
- **WHEN** the user expands the Processes section in the sidebar
- **THEN** the script runner displays each script name from the package.json

#### Scenario: Stop button terminates a running script and updates UI
- **GIVEN** a script is currently running with a visible status indicator
- **WHEN** the user clicks the Stop button on the running script
- **THEN** the script process is terminated
- **AND** the running status indicator disappears
- **AND** the script returns to its idle state

#### Scenario: Processes section toggles between expanded and collapsed
- **GIVEN** the Processes section is visible in the sidebar
- **WHEN** the user clicks the Processes header
- **THEN** the section toggles between expanded and collapsed states
- **AND** collapsing hides the script runner content

### Requirement: FILE-02 — Git Status, Diff Viewer & Version Control

The system SHALL display git status indicators on files, provide a diff viewer for changed files, and support staging, committing, and branch operations.

#### Scenario: Modified file shows M status indicator
- **GIVEN** a file in the project has been modified after the last commit
- **WHEN** the file tree renders
- **THEN** the modified file displays an M status indicator next to its name

#### Scenario: Untracked file shows U status indicator
- **GIVEN** a new file exists in the project that has not been committed
- **WHEN** the file tree renders
- **THEN** the untracked file displays a U status indicator next to its name

#### Scenario: Deleted file shows D status indicator
- **GIVEN** a previously committed file has been deleted from the working directory
- **WHEN** the git changes section renders
- **THEN** the deleted file displays a D status indicator

> Note: Deleted file indicators are inferred from git status integration. Direct E2E test coverage for deletion status may be limited.

#### Scenario: Git changes section lists modified files
- **GIVEN** files have been modified in the project repository
- **WHEN** the user views the Git section in the sidebar
- **THEN** changed files are listed grouped by their staging status

#### Scenario: Diff viewer opens for a changed file
- **GIVEN** the Git section shows a list of changed files
- **WHEN** the user clicks on a changed file entry
- **THEN** a diff viewer opens in the editor pane
- **AND** the viewer displays the file changes using a merge view

#### Scenario: Diff viewer shows added lines with distinct styling
- **GIVEN** the diff viewer is open for a file with additions
- **WHEN** the diff renders
- **THEN** newly added lines are highlighted with a visually distinct style

#### Scenario: Diff viewer shows removed lines with distinct styling
- **GIVEN** the diff viewer is open for a file with deletions
- **WHEN** the diff renders
- **THEN** removed lines are highlighted with a visually distinct style

#### Scenario: Staging a file moves it to the staged section
- **GIVEN** the Git section shows an unstaged changed file
- **WHEN** the user stages the file
- **THEN** the file moves from the unstaged section to the staged section

> Note: Staging interaction (button click vs. drag) depends on the UI. Direct staging E2E test coverage may be limited -- verify during test implementation.

#### Scenario: Unstaging a file returns it to the unstaged section
- **GIVEN** a file is in the staged section
- **WHEN** the user unstages the file
- **THEN** the file moves back to the unstaged section

> Note: Unstaging interaction has limited direct E2E test coverage. Verify mechanism during test implementation.

#### Scenario: Commit with message creates a new commit
- **GIVEN** one or more files are staged in the Git section
- **WHEN** the user enters a commit message and submits the commit
- **THEN** a new git commit is created with the staged files
- **AND** the staged files section clears

> Note: Commit flow E2E coverage is limited. The commit UI exists but end-to-end commit creation may not be fully tested.

#### Scenario: Branch indicator shows current branch name
- **GIVEN** the project has a git repository with branches
- **WHEN** the Git section renders
- **THEN** the current branch name is displayed as a branch indicator

> Note: Branch display is inferred from git integration UI. Dedicated branch indicator E2E test may be a gap.

#### Scenario: Branch switching changes the active branch
- **GIVEN** the branch indicator shows the current branch
- **WHEN** the user selects a different branch from the branch selector
- **THEN** the active branch changes to the selected branch
- **AND** the file tree and git status update to reflect the new branch

> Note: Branch switching E2E test coverage is likely a gap. The feature may exist but lacks dedicated test scenarios.

#### Scenario: Git section expands and collapses
- **GIVEN** the Git section header is visible in the sidebar
- **WHEN** the user clicks the Git header
- **THEN** the section toggles between expanded and collapsed states
- **AND** collapsing hides the changed files list

#### Scenario: Staged and unstaged sections display separately
- **GIVEN** the Git section is expanded and files have been modified
- **WHEN** the git changes render
- **THEN** staged files appear in a separate Staged section
- **AND** unstaged files appear in a separate section below

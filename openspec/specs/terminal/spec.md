# Terminal

**Purpose:** Specifies behavioral scenarios for the embedded terminal emulator including session lifecycle, xterm.js rendering, WebSocket connectivity, multi-instance management, and auto-reconnect behavior.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic exists with a linked project folder
- The terminal pane is available via the add-pane menu in the project sidebar

## Requirements

### TERM-01: Session Lifecycle, Rendering & Connection

The system SHALL support opening terminal sessions with xterm.js rendering, WebSocket-backed communication, keyboard input/output, multi-instance tab management, auto-reconnect after disconnection, and pane resize handling.

#### Scenario: Terminal opens and renders in the pane
- GIVEN a topic with a linked project folder is selected
- WHEN the user opens a terminal via the add-to-project menu and selects Shell
- THEN a terminal emulator renders in the pane with visible text rows
- AND a terminal tab appears in the pane tab bar

#### Scenario: Terminal establishes WebSocket connection on open
- GIVEN the user opens a new terminal session
- WHEN the terminal pane renders
- THEN a WebSocket connection is established to the server for the terminal session
- AND the shell prompt appears indicating the session is ready

#### Scenario: Terminal accepts keyboard input and displays output
- GIVEN a terminal session is open and the shell prompt is visible
- WHEN the user clicks the terminal to focus it and types a command
- THEN the typed characters appear in the terminal
- AND pressing Enter executes the command and displays the output

#### Scenario: Terminal opens with the correct project working directory
- GIVEN a topic is linked to a specific project folder
- WHEN the user opens a terminal session for that topic
- THEN the terminal shell starts in the linked project folder as the working directory

#### Scenario: Terminal auto-reconnects after WebSocket disconnect
- GIVEN a terminal session is active with a working WebSocket connection
- WHEN the WebSocket connection is unexpectedly closed
- THEN the terminal client automatically attempts to reconnect
- AND a new WebSocket connection is established to the server

#### Scenario: Terminal resumes command execution after reconnect
- GIVEN a terminal session has auto-reconnected after a WebSocket disconnect
- WHEN the user types a command in the reconnected terminal
- THEN the command executes successfully
- AND the output is displayed in the terminal

> Note: The PTY process on the server survives WebSocket disconnects. Only the WebSocket transport link is interrupted during reconnection.

#### Scenario: Multiple terminal instances can be opened simultaneously
- GIVEN a terminal session is already open in a pane
- WHEN the user opens another terminal via the add-to-project menu
- THEN a second terminal session opens in a new tab
- AND both terminal tabs are visible in the pane tab bar

#### Scenario: Switching between terminal tabs shows correct session
- GIVEN two terminal sessions are open with different command histories
- WHEN the user clicks the first terminal tab
- THEN the first terminal's content and command history is displayed
- AND clicking the second terminal tab shows the second terminal's content

#### Scenario: Each terminal instance maintains independent session state
- GIVEN two terminal sessions are open
- WHEN the user runs a command in the first terminal
- THEN the command output appears only in the first terminal
- AND the second terminal remains unaffected with its own session state

#### Scenario: Terminal resizes when pane dimensions change
- GIVEN a terminal session is open in a pane
- WHEN the user resizes the pane by dragging a divider
- THEN the terminal adjusts its column and row count to fit the new dimensions
- AND text wrapping updates accordingly

> Note: Terminal resize behavior relies on xterm.js fit addon and server-side PTY resize signaling via WebSocket.

#### Scenario: Terminal preserves scrollback buffer content
- GIVEN a terminal session has produced enough output to fill the visible area
- WHEN the user scrolls up in the terminal
- THEN previously rendered output is visible in the scrollback buffer

#### Scenario: New terminal tab via add-pane menu creates fresh session
- GIVEN a terminal session already exists in the current pane group
- WHEN the user opens a new terminal via the add-to-project menu
- THEN a new independent terminal session is created
- AND the new session starts with a fresh shell prompt

#### Scenario: Closing terminal tab terminates the session
- GIVEN a terminal session is open in a tab
- WHEN the user closes the terminal tab
- THEN the terminal session is terminated on the server
- AND the tab is removed from the pane tab bar

> Note: Session cleanup relies on the server receiving a close signal. Abrupt browser closure may leave orphan sessions until server-side timeout.

#### Scenario: Terminal handles rapid input without dropping characters
- GIVEN a terminal session is open and focused
- WHEN the user types a long command rapidly
- THEN all typed characters appear in the terminal without being dropped or reordered

#### Scenario: Terminal focus is activated by clicking the terminal area
- GIVEN a terminal session is open but not focused
- WHEN the user clicks on the terminal rendering area
- THEN the terminal receives keyboard focus
- AND subsequent keystrokes are sent to the terminal session

#### Scenario: Terminal displays colored output correctly
- GIVEN a terminal session is open
- WHEN a command produces ANSI color-coded output
- THEN the terminal renders the output with the appropriate colors

#### Scenario: Terminal reconnection uses exponential backoff
- GIVEN a terminal session has lost its WebSocket connection
- WHEN the client attempts to auto-reconnect
- THEN reconnection attempts use exponential backoff timing
- AND the client makes up to a maximum number of retry attempts before giving up

> Note: The implementation uses up to 15 retry attempts with exponential backoff. Limited direct test coverage for the full backoff sequence.

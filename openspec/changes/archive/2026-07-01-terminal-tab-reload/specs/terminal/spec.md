## ADDED Requirements

### Requirement: Reload (restart) a terminal session in place

The system SHALL let a user restart a live terminal session **in place** from the
tab's right-click context menu, preserving the tab's identity (the pane id
`terminal:<sessionId>` is unchanged). For `claude-code`, `claude-code-team`, and
`codex` sessions that have a recorded `claude_session_id`, the restart SHALL
relaunch the CLI with `--resume` so the conversation is preserved; for `shell`
sessions it SHALL start a fresh PTY in the same working directory.

The restart SHALL be exposed as a server endpoint `POST
/api/terminal/sessions/:id/reload` that: captures the session's record before
killing it, sends a `kill` to the bridge, waits (bounded) for the PTY to exit, then
recreates the session with the **same** session id via the existing
`createSession` path. The endpoint SHALL be idempotent if the PTY is already dead
(it just recreates) and SHALL return `404` only when no session exists either live
or in the database.

The "Ricarica" menu item SHALL appear **only** for terminal panes (pane id
starting with `terminal:`) and SHALL NOT appear for chat, browser, or other pane
types.

#### Scenario: Reload a wedged Claude session preserves the conversation

- **GIVEN** a `claude-code` terminal session that is stuck (e.g. showing
  `Not logged in · Run /login`) and has a recorded `claude_session_id`
- **WHEN** the user right-clicks its tab and selects "Ricarica"
- **THEN** the server kills the old PTY, waits for it to exit, and relaunches
  `claude --resume <claude_session_id>` with the same session id
- **AND** the tab keeps the same pane id `terminal:<sessionId>` (it does not close
  and reopen)
- **AND** the resumed conversation is available and the stuck banner is gone

#### Scenario: Reload a shell session restarts the PTY in the same cwd

- **GIVEN** a `shell` terminal session running in a project folder
- **WHEN** the user right-clicks its tab and selects "Ricarica"
- **THEN** a fresh PTY is started in the same working directory under the same
  session id
- **AND** no `--resume` is used (shell state is not resumable)

#### Scenario: "Ricarica" is shown only for terminal tabs

- **GIVEN** a tab bar containing a chat tab, a browser tab, and a terminal tab
- **WHEN** the user opens the right-click context menu on each
- **THEN** the "Ricarica" item appears only on the terminal tab's menu

#### Scenario: Reload is idempotent when the PTY is already dead

- **GIVEN** a terminal session whose PTY has already exited (dormant or removed)
- **WHEN** `POST /api/terminal/sessions/:id/reload` is called
- **THEN** the session is recreated with the same id without error
- **AND** the response reports the active session

#### Scenario: Reload of a non-existent session returns 404

- **GIVEN** a session id that exists neither in the live session map nor in the
  database
- **WHEN** `POST /api/terminal/sessions/:id/reload` is called
- **THEN** the server responds `404`

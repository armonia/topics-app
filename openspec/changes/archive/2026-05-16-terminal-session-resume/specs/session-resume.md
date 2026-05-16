# Spec: Terminal Session Resume on Server Restart

## AC-1: New Claude Code sessions get a session ID
- **GIVEN** a user creates a new Claude Code terminal session
- **WHEN** the session is spawned via the PTY bridge
- **THEN** a UUID is generated and passed as `--session-id <uuid>` to the `claude` CLI
- **AND** the UUID is stored in the `claude_session_id` column of `terminal_sessions`

## AC-2: Server restart resumes Claude Code sessions
- **GIVEN** a Claude Code terminal session exists in the database with a `claude_session_id`
- **WHEN** the server restarts and `restoreSessions()` runs
- **THEN** the session is spawned with `claude --resume <session-id>` (plus existing flags like `--dangerously-skip-permissions`)
- **AND** Claude Code resumes the previous conversation context

## AC-3: Legacy sessions without session ID fall back gracefully
- **GIVEN** a Claude Code terminal session exists in the database WITHOUT a `claude_session_id` (pre-migration)
- **WHEN** the server restarts and `restoreSessions()` runs
- **THEN** the session is spawned with bare `claude` (current behavior)
- **AND** no errors or crashes occur

## AC-4: SIGTERM handler for graceful shutdown
- **GIVEN** the server is running with active terminal sessions
- **WHEN** the server receives SIGTERM (e.g., from `bun --watch` restart)
- **THEN** the PTY bridge and database are closed cleanly (same as SIGINT handler)

## AC-5: Database migration adds claude_session_id column
- **GIVEN** the application starts with an existing database
- **WHEN** migrations run
- **THEN** the `terminal_sessions` table has a `claude_session_id TEXT` column
- **AND** existing rows have `NULL` for this column (triggering AC-3 fallback)

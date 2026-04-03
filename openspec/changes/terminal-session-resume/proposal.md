# Terminal Session Resume on Server Restart

## What
When the Topics App server restarts (e.g., due to `bun --watch` detecting file changes), Claude Code terminal sessions are killed and respawned from scratch — losing all conversation context. Fix this by using Claude Code's `--resume` flag to restore the previous session on restart.

## Why
During development, editing any server file triggers a hot reload via `bun --watch`. This kills the PTY bridge process, which kills all child processes including active Claude Code sessions. The current `restoreSessions()` recreates sessions from the DB but spawns a **fresh** `claude` process — the conversation history, tools state, and working context are all lost. This is the #1 pain point when developing server-side features while using embedded Claude Code terminals.

## Scope
- **Server**: modify terminal session creation/restoration to capture and use Claude Code session IDs
- **PTY Bridge**: extract Claude Code session ID from PTY output during startup
- **Database**: add `claude_session_id` column to `terminal_sessions` table
- **No client changes required** — the terminal UI reconnects transparently

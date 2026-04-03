# Tasks: Terminal Session Resume

## Task 1: Database migration
- [ ] Create migration file adding `claude_session_id TEXT` to `terminal_sessions`

## Task 2: Pass --session-id on new Claude Code sessions
- [ ] In `createSession()`: generate UUID for claude-code sessions
- [ ] Add `--session-id <uuid>` to claude args
- [ ] Store `claude_session_id` in DB INSERT

## Task 3: Use --resume on session restore
- [ ] In `restoreSessions()`: check if `claude_session_id` exists
- [ ] If yes: spawn `claude --resume <session-id>` (+ other flags)
- [ ] If no: spawn bare `claude` (current fallback)

## Task 4: Add SIGTERM handler
- [ ] Add `process.on("SIGTERM", ...)` in server.ts mirroring the SIGINT handler

## Task 5: Verify end-to-end
- [ ] Create a Claude Code terminal session
- [ ] Verify session ID is stored in DB
- [ ] Restart server
- [ ] Verify session resumes with `--resume` flag

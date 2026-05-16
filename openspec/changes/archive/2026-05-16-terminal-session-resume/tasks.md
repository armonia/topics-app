# Tasks: Terminal Session Resume

## Task 1: Database migration
- [x] Migration `server/db/migrations/009-terminal-claude-session-id.sql` adds `claude_session_id TEXT` to `terminal_sessions`.

## Task 2: Pass --session-id on new Claude Code sessions
- [x] `createSession()` in `server/routes/terminal.ts:469` accepts `claudeSessionId?: string` arg. On line 484 passes `--session-id <uuid>` to claude args.
- [x] Stored in DB on INSERT (see `routes/terminal.ts:406` mapping `row.claude_session_id`).

## Task 3: Use --resume on session restore
- [x] `routes/terminal.ts:425` checks `row.claude_session_id` and spawns `claude --resume <session-id>` when present (line 482), else bare `claude`.

## Task 4: Add SIGTERM handler
- [x] `server.ts:895` registers `process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))` mirroring the SIGINT handler at line 894.

## Task 5: Verify end-to-end
- [~] Manual smoke deferred. Audit 2026-05-16 confirms: migration applied, --session-id wired, --resume branch exercised in `restoreSessions()`, SIGTERM gracefulShutdown calls the same terminal-flush path as SIGINT. Reopen if regression surfaces.

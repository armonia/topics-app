# Design: Terminal Session Resume

## Current Flow (broken)
1. Server starts → `restoreSessions()` reads terminal_sessions from DB
2. For each row: `createSession(id, name, cwd, ...)` → spawns `claude` (fresh process)
3. Claude Code starts a brand new conversation — all previous context lost

## New Flow
1. When a Claude Code session starts, capture its session ID from the PTY output
2. Store the session ID in the `terminal_sessions` DB table
3. On server restart, `restoreSessions()` spawns `claude --resume <session-id>` instead of bare `claude`
4. Claude Code resumes the exact conversation where it left off

## Implementation Details

### 1. Capture Claude Code Session ID
Claude Code prints session metadata on startup. We need to parse the PTY output to extract the session ID. Two approaches:
- **Option A**: Parse terminal output for session ID pattern (fragile, depends on output format)
- **Option B**: Use `--session-id <uuid>` flag to **assign** a known UUID at creation time, then reuse it with `--resume`

**Chosen: Option B** — more reliable, no output parsing needed. We generate a UUID, pass it via `--session-id` on first launch, then use `--resume <session-id>` on restore.

### 2. Database Migration
Add `claude_session_id TEXT` column to `terminal_sessions` table.

### 3. Session Creation (terminal.ts)
- For `claude-code` type sessions: generate a `claude_session_id` UUID
- Pass `--session-id <uuid>` as argument to the claude process
- Store in DB alongside other session metadata

### 4. Session Restoration (terminal.ts)
- For `claude-code` type sessions with a stored `claude_session_id`:
  - Use `--resume <session-id>` instead of bare `claude`
- For sessions without a stored ID (legacy): fall back to current behavior (fresh start)

### 5. Graceful Shutdown
- Add `SIGTERM` handler to server.ts (currently only handles `SIGINT`)
- Both handlers should cleanly close the PTY bridge

### Files Changed
- `server/routes/terminal.ts` — session creation and restoration logic
- `server/db/migrations/` — new migration for `claude_session_id` column
- `server.ts` — add SIGTERM handler

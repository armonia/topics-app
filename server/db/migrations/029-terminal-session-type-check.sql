-- 029-terminal-session-type-check.sql: widen the terminal_sessions.type CHECK.
--
-- Migration 008 created the table with CHECK(type IN ('shell','claude-code')).
-- Two interactive agent types were added later WITHOUT widening that CHECK:
--   • 'claude-code-team' (Master/orchestrator mode)
--   • 'codex'            (OpenAI CLI pane)
-- Every INSERT for those types violates the CHECK. createSession wraps the
-- INSERT in a swallow-all try/catch, so the violation was SILENT: the session
-- ran fine in memory for the lifetime of the process, but NO row was ever
-- persisted. On a server/bridge restart reconcileSessions found no DB row, so
-- the session couldn't be reattached or parked dormant — it simply vanished.
-- (This is the real root cause of "codex disappears after a refresh/restart",
-- deeper than the dormant/revive nuances.)
--
-- SQLite cannot ALTER an existing CHECK constraint, so we rebuild the table
-- (same 12-step pattern as migration 023). Nothing FK-references
-- terminal_sessions and the only index is the PRIMARY KEY autoindex, so the
-- rebuild is a straight copy. The new CHECK enumerates every type the
-- application actually spawns (see TerminalSession.type in server/routes/
-- terminal.ts and TerminalAgentType in client terminalAgents.ts).

CREATE TABLE terminal_sessions_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT,
  type TEXT NOT NULL DEFAULT 'shell'
    CHECK(type IN ('shell', 'claude-code', 'claude-code-team', 'codex')),
  topic_id TEXT,
  cols INTEGER NOT NULL DEFAULT 120,
  rows INTEGER NOT NULL DEFAULT 30,
  skip_permissions INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  parent_session_key TEXT
);

INSERT INTO terminal_sessions_new
  (id, name, cwd, command, type, topic_id, cols, rows, skip_permissions,
   created_at, claude_session_id, status, parent_session_key)
SELECT
  id, name, cwd, command, type, topic_id, cols, rows, skip_permissions,
  created_at, claude_session_id, status, parent_session_key
FROM terminal_sessions;

DROP TABLE terminal_sessions;
ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;

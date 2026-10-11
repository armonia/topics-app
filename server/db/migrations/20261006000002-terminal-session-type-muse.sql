-- 20261006000002-terminal-session-type-muse.sql: adds 'muse' to the
-- terminal_sessions.type CHECK.
--
-- The same fix migration 029 applied for 'codex'/'claude-code-team', 066 for
-- 'opencode' and 20260827130000 for 'kimi-code': the 'muse' terminal agent
-- (Muse CLI in an interactive PTY) was added to the application without
-- touching the CHECK, so EVERY insert of a muse pane would violate the
-- constraint — the session would run in memory and vanish on restart (see 066
-- for the symptom in detail).
--
-- SQLite cannot ALTER a CHECK, so the table is rebuilt (the same 12-step
-- pattern as 023, 029, 066 and the kimi-code migration). Nothing references it
-- via FK and the only index is the PRIMARY KEY autoindex, so it is a straight
-- copy. The column list mirrors the live schema INCLUDING exit_code (added by
-- 20260916003000, after the kimi-code rebuild): omitting it would drop the
-- column and every recorded exit code with it.

CREATE TABLE terminal_sessions_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT,
  type TEXT NOT NULL DEFAULT 'shell'
    CHECK(type IN ('shell', 'claude-code', 'claude-code-team', 'codex', 'opencode', 'kimi-code', 'muse')),
  topic_id TEXT,
  cols INTEGER NOT NULL DEFAULT 120,
  rows INTEGER NOT NULL DEFAULT 30,
  skip_permissions INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  parent_session_key TEXT,
  name_source TEXT NOT NULL DEFAULT 'default',
  exit_code INTEGER DEFAULT NULL
);

INSERT INTO terminal_sessions_new
  (id, name, cwd, command, type, topic_id, cols, rows, skip_permissions,
   created_at, claude_session_id, status, parent_session_key, name_source,
   exit_code)
SELECT
  id, name, cwd, command, type, topic_id, cols, rows, skip_permissions,
  created_at, claude_session_id, status, parent_session_key, name_source,
  exit_code
FROM terminal_sessions;

DROP TABLE terminal_sessions;
ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;

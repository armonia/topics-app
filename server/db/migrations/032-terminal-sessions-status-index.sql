-- 032-terminal-sessions-status-index.sql: secondary index on terminal_sessions.status.
--
-- The table has only its PRIMARY KEY autoindex (noted in migration 029), while
-- the hot paths filter on status: the dormant-shell pruner
-- (DELETE ... WHERE status = 'dormant' AND ... , terminal.ts) and the
-- dormant-session lookups by status/cwd. Active pruning keeps the table small,
-- so these full scans were cheap — but the index costs nothing and removes the
-- scan entirely.
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status ON terminal_sessions(status);

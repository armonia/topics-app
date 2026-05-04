-- 022-claude-code-sessions.sql: persist a stable Claude CLI session UUID per
-- topic sessionKey so the claude-code provider can `--resume` after the
-- in-memory child process dies (hot reload, inactivity timeout, lifetime cap,
-- crash). Without this row, every spawn started a brand-new conversation and
-- the AI forgot all prior turns even though the messages were intact in DB.

CREATE TABLE IF NOT EXISTS claude_code_sessions (
  session_key TEXT PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claude_code_sessions_updated ON claude_code_sessions(updated_at);

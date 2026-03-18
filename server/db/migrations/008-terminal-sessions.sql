-- 008-terminal-sessions.sql: Persist terminal sessions across server restarts

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT,
  type TEXT NOT NULL DEFAULT 'shell' CHECK(type IN ('shell', 'claude-code')),
  topic_id TEXT,
  cols INTEGER NOT NULL DEFAULT 120,
  rows INTEGER NOT NULL DEFAULT 30,
  skip_permissions INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

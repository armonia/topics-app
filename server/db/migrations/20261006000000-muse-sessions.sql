-- 20261006000000-muse-sessions.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Persist a stable Muse CLI session id per topic sessionKey, the muse analogue
-- of `codex_sessions` (20260910000153). Without this row, the muse chat provider
-- could not pass `--session-id` on the next turn, and every turn would start a
-- fresh Muse session instead of resuming the topic's conversation.

CREATE TABLE IF NOT EXISTS muse_sessions (
  session_key TEXT PRIMARY KEY,
  muse_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_muse_sessions_updated ON muse_sessions(updated_at);

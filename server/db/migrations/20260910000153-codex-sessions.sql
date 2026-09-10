-- 20260910000153-codex-sessions.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Persist a stable Codex CLI thread id per topic sessionKey, the codex analogue
-- of `claude_code_sessions` (022/023). Without this row, the codex chat provider
-- re-sends a hand-truncated markdown transcript on every turn instead of letting
-- `codex exec resume <thread_id>` carry native, unbounded context.

CREATE TABLE IF NOT EXISTS codex_sessions (
  session_key TEXT PRIMARY KEY,
  codex_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_codex_sessions_updated ON codex_sessions(updated_at);

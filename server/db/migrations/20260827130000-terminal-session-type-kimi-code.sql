-- 20260827130000-terminal-session-type-kimi-code.sql: aggiunge 'kimi-code' al
-- CHECK di terminal_sessions.type.
--
-- La stessa cosa risolta dalla migration 029 per 'codex'/'claude-code-team' e
-- dalla 066 per 'opencode': il tipo 'kimi-code' è stato aggiunto
-- all'applicazione (Kimi Code come agente terminale, menu "+") senza toccare
-- il CHECK. Il vincolo enumerava
-- ('shell','claude-code','claude-code-team','codex','opencode'), quindi OGNI
-- insert di una pane kimi-code lo avrebbe violato — la sessione sarebbe girata
-- in memoria e sparita al riavvio (vedi 066 per il dettaglio del sintomo).
--
-- SQLite non sa ALTERare un CHECK, quindi si ricostruisce la tabella (stesso
-- pattern a 12 passi della 023, 029 e 066). Nulla la referenzia via FK e
-- l'unico indice è l'autoindex della PRIMARY KEY, quindi è una copia diretta.

CREATE TABLE terminal_sessions_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT,
  type TEXT NOT NULL DEFAULT 'shell'
    CHECK(type IN ('shell', 'claude-code', 'claude-code-team', 'codex', 'opencode', 'kimi-code')),
  topic_id TEXT,
  cols INTEGER NOT NULL DEFAULT 120,
  rows INTEGER NOT NULL DEFAULT 30,
  skip_permissions INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  parent_session_key TEXT,
  name_source TEXT NOT NULL DEFAULT 'default'
);

INSERT INTO terminal_sessions_new
  (id, name, cwd, command, type, topic_id, cols, rows, skip_permissions,
   created_at, claude_session_id, status, parent_session_key, name_source)
SELECT
  id, name, cwd, command, type, topic_id, cols, rows, skip_permissions,
  created_at, claude_session_id, status, parent_session_key, name_source
FROM terminal_sessions;

DROP TABLE terminal_sessions;
ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;

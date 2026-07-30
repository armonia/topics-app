-- 066-terminal-session-type-opencode.sql: aggiunge 'opencode' al CHECK di
-- terminal_sessions.type.
--
-- La stessa cosa che la migration 029 ha risolto per 'codex' e
-- 'claude-code-team', ricomparsa: il tipo 'opencode' è stato aggiunto
-- all'applicazione senza toccare il CHECK. Il vincolo enumerava
-- ('shell','claude-code','claude-code-team','codex'), quindi OGNI insert di una
-- pane opencode violava il CHECK.
--
-- L'insert in `createSession` (server/routes/terminal.ts) è dentro un try/catch
-- che ORA logga forte — proprio grazie al commento lasciato dalla 029 — ma
-- logga e tira avanti: la sessione girava in memoria per la vita del processo e
-- nessuna riga veniva mai scritta. Al riavvio del server o del bridge
-- `reconcileSessions` non trovava la riga, quindi la sessione non era né
-- riagganciabile né parcheggiabile: la pane spariva e il PTY veniva ucciso.
--
-- SQLite non sa ALTERare un CHECK, quindi si ricostruisce la tabella (stesso
-- pattern a 12 passi della 023 e della 029). Nulla la referenzia via FK e
-- l'unico indice è l'autoindex della PRIMARY KEY, quindi è una copia diretta.
-- Rispetto alla 029 la tabella ha una colonna in più, `name_source`
-- (migration 037): va elencata, o il RENAME la perde.
--
-- 'claude-code-team' resta nell'elenco: è un tipo legacy (nessuna riga lo usa
-- nel DB di sviluppo) ma togliere un valore dal CHECK è un'altra decisione, e
-- se una riga esistesse la copia qui sotto la rifiuterebbe portandosi via la
-- tabella. Si rimuove quando si rimuove il tipo dal codice, non di sponda.

CREATE TABLE terminal_sessions_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT,
  type TEXT NOT NULL DEFAULT 'shell'
    CHECK(type IN ('shell', 'claude-code', 'claude-code-team', 'codex', 'opencode')),
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

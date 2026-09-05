-- 20260904110000-global-orchestrator-sessions.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter.  It keeps
-- independently-created migrations from colliding.
--
-- The global Kanban orchestrator is an ordinary Topic.  This table is its
-- durable registry: it is the ONLY identity for that privileged role.  Topic
-- names, titles, project paths, and MCP policy are mutable presentation or
-- configuration data and must never be used to infer the role.
CREATE TABLE IF NOT EXISTS global_orchestrator_sessions (
  scope TEXT PRIMARY KEY CHECK (scope = 'global'),
  topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

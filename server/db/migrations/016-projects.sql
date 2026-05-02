-- 016-projects.sql: Add `projects` table — first-class Project entity.
--
-- Why: today a "project" is just a string (`topics.project_path` or
-- `tasks.project_id`). There is no canonical record holding name, color,
-- icon, sync settings, or archive flag. This change introduces the table
-- so Project becomes a real entity that worktrees and (later phases)
-- multi-machine state can foreign-key into.
--
-- Backward-compat invariant: this migration ONLY creates a new table.
-- It does NOT touch `topics.project_path` or `tasks.project_id`. Legacy
-- code paths that key by string continue to work exactly as today.
-- Auto-creation of project records is deferred to user action — no
-- backfill of existing `project_path` strings happens here.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (16, '016-projects', datetime('now'));

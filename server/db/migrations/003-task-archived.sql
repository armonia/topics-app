-- Add archived column to tasks
ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);

-- Track migration
INSERT INTO schema_migrations (version, name, applied_at)
VALUES (3, 'task-archived', datetime('now'));

-- Record the actual action surface without changing author identity or permissions.
-- NULL is intentional for history written before the source was known.
ALTER TABLE task_comments ADD COLUMN origin TEXT
  CHECK (origin IN ('interface', 'mcp', 'api', 'system')) DEFAULT NULL;

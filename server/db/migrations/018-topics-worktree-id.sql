-- 018-topics-worktree-id.sql: Add optional worktree_id FK on topics.
--
-- Why: a topic MAY now bind to a specific worktree of a project so chat,
-- tool calls, and slash commands operate inside the worktree's working
-- copy instead of the project's primary path.
--
-- Backward-compat invariant: column is NULLABLE. Topics without a
-- worktree binding (legacy rows + new rows created with the default
-- "Use project path directly" option) continue to behave exactly as
-- before this migration — the chat path falls back to topics.project_path
-- whenever worktree_id IS NULL.
--
-- ON DELETE SET NULL: deleting a worktree must not delete the topic. The
-- topic gracefully degrades to its project_path on worktree deletion.
-- The accompanying purgeTopicFromUiState extension (see routes/topics.ts
-- in this change) cleans any persisted ui_state references in the same
-- BEGIN IMMEDIATE transaction that bumps server_seq, preserving the
-- payload_version=2 LWW invariant established by migration 012.

ALTER TABLE topics ADD COLUMN worktree_id TEXT
  REFERENCES worktrees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_topics_worktree ON topics(worktree_id);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (18, '018-topics-worktree-id', datetime('now'));

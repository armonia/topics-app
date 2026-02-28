-- Message branching: add parent_id and branch_index to messages
-- parent_id links each message to its predecessor, forming a tree.
-- branch_index differentiates siblings (children of the same parent).

ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN branch_index INTEGER NOT NULL DEFAULT 0;

-- Track which branch is active at each fork point
CREATE TABLE IF NOT EXISTS active_branches (
  parent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  active_branch_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (parent_id, session_key)
);

-- Indexes for efficient tree traversal
CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_parent ON messages(session_key, parent_id);

-- Record migration
INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, '005-message-branching', datetime('now'));

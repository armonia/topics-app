-- 026-master-topic-mode.sql: add Master/Teammate topic relationships and
-- task↔topic bindings for Claude Code Agent Teams orchestration.
--
-- All columns are nullable / additive — existing topics and tasks behave
-- exactly as before. New columns are populated only when a topic is spawned
-- in team mode (see openspec/changes/add-master-topic-mode/).

-- Master/Teammate topic relationship.
ALTER TABLE topics ADD COLUMN parent_topic_id TEXT REFERENCES topics(id);
ALTER TABLE topics ADD COLUMN agent_team_role TEXT
  CHECK(agent_team_role IS NULL OR agent_team_role IN ('lead','teammate'));

-- Note: topics already has claude_session_id-equivalent state via
-- claude_code_sessions(session_key). We do NOT add a duplicate column here.

CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(parent_topic_id);
CREATE INDEX IF NOT EXISTS idx_topics_team_role ON topics(agent_team_role);

-- Task ↔ Topic binding for jump-to-tab from kanban board.
ALTER TABLE tasks ADD COLUMN assigned_topic_id TEXT REFERENCES topics(id);
ALTER TABLE tasks ADD COLUMN claude_task_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_topic ON tasks(assigned_topic_id);

-- Stream-json event store for reasoning trail (Phase E).
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_task_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY(topic_id) REFERENCES topics(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(claude_task_id, ts);
CREATE INDEX IF NOT EXISTS idx_task_events_topic ON task_events(topic_id, ts);

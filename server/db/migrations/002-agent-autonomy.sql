-- 002-agent-autonomy.sql: Agent Autonomy — new columns, tables, indexes
-- Enables autonomous agent interaction with the board via API tokens

-- ============================================================
-- AGENT PROFILES — Autonomy Extensions
-- ============================================================

ALTER TABLE agent_profiles ADD COLUMN agent_token_hash TEXT;
ALTER TABLE agent_profiles ADD COLUMN gateway_session_id TEXT;
ALTER TABLE agent_profiles ADD COLUMN heartbeat_config TEXT DEFAULT '{"interval_seconds":30,"missing_tolerance":120}';
ALTER TABLE agent_profiles ADD COLUMN identity_template TEXT;
ALTER TABLE agent_profiles ADD COLUMN soul_template TEXT;
ALTER TABLE agent_profiles ADD COLUMN is_board_lead INTEGER DEFAULT 0;
ALTER TABLE agent_profiles ADD COLUMN last_seen_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_profiles_token ON agent_profiles(agent_token_hash);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_status ON agent_profiles(status);

-- ============================================================
-- TASKS — Agent assignment column
-- ============================================================

ALTER TABLE tasks ADD COLUMN assigned_agent_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN in_progress_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id);

-- ============================================================
-- BOARD MEMORY — Shared context between agents
-- ============================================================

CREATE TABLE IF NOT EXISTS board_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  is_chat INTEGER DEFAULT 0,
  source TEXT,
  agent_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_memory_project ON board_memory(project_id);
CREATE INDEX IF NOT EXISTS idx_board_memory_chat ON board_memory(is_chat);

-- ============================================================
-- AGENT ACTIONS LOG — Immutable audit trail
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_actions_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_agent ON agent_actions_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_type ON agent_actions_log(action_type);

-- ============================================================
-- Record this migration
-- ============================================================

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (2, '002-agent-autonomy', datetime('now'));

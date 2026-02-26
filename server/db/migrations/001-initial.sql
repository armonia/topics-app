-- 001-initial.sql: Core schema for Topics App SQLite migration
-- Replaces JSON file storage with relational tables
-- Note: PRAGMA statements are set in db.ts, not here (they don't work inside transactions)

-- ============================================================
-- TOPICS & RELATIONSHIPS
-- ============================================================

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  session_key TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#6366f1',
  icon TEXT NOT NULL DEFAULT '💬',
  system_prompt TEXT,
  project_path TEXT,
  sort_order INTEGER DEFAULT 0,
  autonomy_level TEXT DEFAULT 'ask' CHECK(autonomy_level IN ('ask', 'auto-apply', 'yolo')),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(parent_id);
CREATE INDEX IF NOT EXISTS idx_topics_session ON topics(session_key);
CREATE INDEX IF NOT EXISTS idx_topics_archived ON topics(archived);

-- Topic cross-references (many-to-many links between topics)
CREATE TABLE IF NOT EXISTS topic_links (
  source_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, target_id)
);

-- Context files attached to topics
CREATE TABLE IF NOT EXISTS topic_context_files (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  PRIMARY KEY (topic_id, file_path)
);

-- Pinned messages per topic
CREATE TABLE IF NOT EXISTS topic_pinned_messages (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  PRIMARY KEY (topic_id, message_id)
);

-- Disabled context sources per topic
CREATE TABLE IF NOT EXISTS topic_disabled_sources (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  PRIMARY KEY (topic_id, source_id)
);

-- Disabled context templates per topic
CREATE TABLE IF NOT EXISTS topic_disabled_templates (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  PRIMARY KEY (topic_id, template_name)
);

-- ============================================================
-- MESSAGES
-- ============================================================

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT,
  tool_calls TEXT,  -- JSON array of ToolCall objects
  media TEXT,       -- JSON array of media file paths
  partial INTEGER DEFAULT 0,
  streamed_at TEXT,
  plan_status TEXT CHECK(plan_status IN ('approved', 'rejected', NULL)),
  timestamp TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key);
CREATE INDEX IF NOT EXISTS idx_messages_session_order ON messages(session_key, sort_order);

-- ============================================================
-- UNREAD TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS unread (
  topic_id TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- USAGE TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  topic_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_key);
CREATE INDEX IF NOT EXISTS idx_usage_topic ON usage_records(topic_id);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model);

-- ============================================================
-- MEMORY
-- ============================================================

CREATE TABLE IF NOT EXISTS memory (
  scope TEXT NOT NULL DEFAULT 'global',
  topic_id TEXT NOT NULL DEFAULT '__global__',
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, topic_id)
);

-- ============================================================
-- TASKS (basic schema, extended in Phase 2 migration)
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('backlog', 'todo', 'in_progress', 'review', 'done')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 4),
  kanban_order INTEGER NOT NULL DEFAULT 0,
  assigned_to TEXT,
  fingerprint TEXT,
  due_date TEXT,
  chat_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

-- ============================================================
-- TASK DEPENDENCIES (Phase 2, included for forward compat)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_dependencies (
  blocker_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- ============================================================
-- TAGS (Phase 2)
-- ============================================================

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

-- ============================================================
-- TASK COMMENTS (Phase 2)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  mentions TEXT, -- JSON array
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

-- ============================================================
-- AGENT PROFILES (Phase 3)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'worker' CHECK(role IN ('lead', 'worker', 'specialist')),
  model_preference TEXT,
  max_concurrent_tasks INTEGER DEFAULT 1,
  capabilities TEXT, -- JSON array
  avatar_emoji TEXT DEFAULT '🤖',
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'busy', 'paused', 'offline')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Agent-to-Topic assignments
CREATE TABLE IF NOT EXISTS agent_assignments (
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'worker' CHECK(role IN ('lead', 'worker')),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, topic_id)
);

-- Agent sessions (work sessions)
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  session_key TEXT NOT NULL,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'error', 'stale')),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  last_heartbeat TEXT,
  completed_at TEXT,
  total_tokens INTEGER DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);

-- Heartbeat log (rolling window)
CREATE TABLE IF NOT EXISTS heartbeats (
  session_key TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  current_task TEXT,
  PRIMARY KEY (session_key, timestamp)
);

-- ============================================================
-- APPROVALS (Phase 4)
-- ============================================================

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  approval_type TEXT NOT NULL CHECK(approval_type IN ('status_change', 'completion', 'review')),
  from_status TEXT,
  to_status TEXT,
  confidence_score REAL,
  rubric_scores TEXT, -- JSON object
  justification TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  reviewed_by TEXT,
  review_comment TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- Board settings per project
CREATE TABLE IF NOT EXISTS board_settings (
  project_id TEXT PRIMARY KEY,
  require_approval_for_done INTEGER DEFAULT 0,
  require_review_before_done INTEGER DEFAULT 0,
  block_status_with_pending INTEGER DEFAULT 0,
  only_lead_can_change_status INTEGER DEFAULT 0,
  max_agents INTEGER DEFAULT 5,
  auto_expire_hours INTEGER DEFAULT 24
);

-- ============================================================
-- WEBHOOKS (Phase 6)
-- ============================================================

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL, -- JSON array of event types
  active INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 5,
  timeout_ms INTEGER NOT NULL DEFAULT 5000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'success', 'failed')),
  http_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);

-- ============================================================
-- ACTIVITY LOG (Phase 6)
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug', 'info', 'warn', 'error')),
  title TEXT NOT NULL,
  detail TEXT,
  entity_type TEXT,
  entity_id TEXT,
  actor TEXT,
  session_key TEXT,
  metadata TEXT -- JSON object
);

CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_activity_category ON activity_log(category);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);

-- ============================================================
-- MENTIONS (Phase 7)
-- ============================================================

CREATE TABLE IF NOT EXISTS mentions (
  message_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  mentioned_entity TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'agent' CHECK(entity_type IN ('agent', 'user', 'all')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, mentioned_entity)
);

CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(mentioned_entity);

-- ============================================================
-- SCHEMA VERSIONING
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- Record this migration
INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (1, '001-initial', datetime('now'));

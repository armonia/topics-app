-- A chat the system created for work (a card's agent, an attempt of a fan-out,
-- a native child), marked once at birth. It outlives every mutable link: the
-- requeue and the park clear `tasks.assigned_topic_id`, a relaunch overwrites
-- `chat_id`, so deriving "system chat" from those fields forgot the chat.
CREATE TABLE IF NOT EXISTS system_chats (
  topic_id   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Chats born before the marker existed, from the links that still stand.
INSERT OR IGNORE INTO system_chats (topic_id, kind, created_at)
  SELECT assigned_topic_id, 'task', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks WHERE assigned_topic_id IS NOT NULL;
INSERT OR IGNORE INTO system_chats (topic_id, kind, created_at)
  SELECT chat_id, 'task', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks WHERE chat_id IS NOT NULL;
INSERT OR IGNORE INTO system_chats (topic_id, kind, created_at)
  SELECT topic_id, 'attempt', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM task_attempts WHERE topic_id IS NOT NULL;
INSERT OR IGNORE INTO system_chats (topic_id, kind, created_at)
  SELECT id, 'subagent', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM subagents WHERE runtime = 'topics';

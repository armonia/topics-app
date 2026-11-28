-- 20261128120000-readable-view-settings-phrases.sql
--
-- Two small tables for the readable-view fallback (card 62ec8528):
--   readable_view_settings  the switch and the model, one row, read by the
--                           server so a client never chooses the model.
--   tool_phrase_cache       the model's one-line phrase and category for an
--                           MCP tool name never seen, one model call per name.
-- Both are IF NOT EXISTS / INSERT OR IGNORE, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS readable_view_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fallback_enabled INTEGER NOT NULL DEFAULT 1,
  model TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO readable_view_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS tool_phrase_cache (
  tool_name TEXT PRIMARY KEY,
  phrase TEXT,
  category TEXT,
  created_at TEXT NOT NULL
);

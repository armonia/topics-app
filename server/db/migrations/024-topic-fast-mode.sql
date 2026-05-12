-- 024-topic-fast-mode.sql: persist per-topic Fast Mode toggle.
--
-- Fast Mode is a binary opt-in that tells the chat route to use the provider's
-- native "fast model" (e.g. claude-haiku, gpt-4o-mini) when no explicit model
-- override is supplied. Persisted at the topic level so the toggle survives
-- across refreshes, app restarts, and devices — and so multiple windows of
-- the same topic stay in sync via the topic:updated WS broadcast.
--
-- Default 0 (OFF) keeps backward compatibility for every existing topic.

ALTER TABLE topics ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (24, '024-topic-fast-mode', datetime('now'));

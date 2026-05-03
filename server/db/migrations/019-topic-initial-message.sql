-- 019-topic-initial-message.sql: Phase C — one-shot initial message field.
--
-- Captures the user's first prompt at topic-create time so the renderer
-- can auto-dispatch it as soon as the provider connects. Eliminates the
-- "spinner of dread" between opening a topic and typing.
--
-- Backward-compat: column is NULLABLE with no default. Legacy rows
-- continue to behave exactly as before. NULL means "no queued message" —
-- the renderer reads, dispatches, then PATCHes back to NULL.

ALTER TABLE topics ADD COLUMN initial_message TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (19, '019-topic-initial-message', datetime('now'));

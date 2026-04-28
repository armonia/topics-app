-- Add optional per-topic model field. Persists the user's last-used model so
-- closing and reopening a topic remembers it; pairs with the existing
-- `provider` column. NULL = use the provider's default model.
ALTER TABLE topics ADD COLUMN model TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (13, '013-topic-model', datetime('now'));

-- Optional per-message metadata for the new assistant-message footer
-- (Slice 7). All fields are nullable; old rows render no footer. Populated
-- when the provider reports usage in the final stream event.
ALTER TABLE messages ADD COLUMN latency_ms INTEGER;
ALTER TABLE messages ADD COLUMN usage_prompt_tokens INTEGER;
ALTER TABLE messages ADD COLUMN usage_completion_tokens INTEGER;
ALTER TABLE messages ADD COLUMN cost_cents INTEGER;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (14, '014-message-meta', datetime('now'));

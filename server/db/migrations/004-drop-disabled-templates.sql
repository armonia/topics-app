-- Remove unused topic_disabled_templates table
DROP TABLE IF EXISTS topic_disabled_templates;

-- Track migration
INSERT INTO schema_migrations (version, name, applied_at)
VALUES (4, 'drop-disabled-templates', datetime('now'));

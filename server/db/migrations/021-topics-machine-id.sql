-- 021-topics-machine-id.sql: Phase D — optional machine binding for topics.
--
-- A topic MAY know which machine it last ran on. NULL = unspecified
-- (legacy + future "global" topics). FK ON DELETE SET NULL: machine
-- removal degrades the topic gracefully.

ALTER TABLE topics ADD COLUMN machine_id TEXT
  REFERENCES machines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_topics_machine ON topics(machine_id);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (21, '021-topics-machine-id', datetime('now'));

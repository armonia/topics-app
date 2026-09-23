-- 20260922180000-ai-control-topics-routing.sql
--
-- AICTRL-01/04: the routing switch is a separate axis from provider/model,
-- so it needs its own column instead of living inside the encoded
-- `provider:model` string. NULL means "never set explicitly": the reader
-- falls back to the legacy `topics:<model>` prefix (routing was implicitly
-- on) or to off otherwise, per shared/task-coding-models.ts. No backfill
-- and no rewrite of existing `model`/`provider` values: AICTRL-04 forbids a
-- destructive migration, and NULL already reads correctly through the
-- legacy path.
ALTER TABLE tasks ADD COLUMN topics_routing INTEGER CHECK (topics_routing IN (0, 1));
ALTER TABLE topics ADD COLUMN topics_routing INTEGER CHECK (topics_routing IN (0, 1));

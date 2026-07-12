-- 033-topic-effort.sql: persist per-topic reasoning-effort tier.
--
-- Until now the effort tier ("--effort xhigh" for claude-code) was a global
-- policy resolved from env (resolveClaudeEffort → TOPICS_CLAUDE_EFFORT /
-- CLAUDE_EFFORT / "xhigh") and shown as a read-only badge in the model picker.
-- This column lets a topic override that tier from the UI selector. NULL = no
-- override → fall back to the global env-resolved default (backward compatible
-- for every existing topic). Valid values mirror VALID_CLAUDE_EFFORTS:
-- low / medium / high / xhigh / max. The value takes effect on the next CLI
-- spawn for the topic's session (the chat route forces an idle respawn on
-- change so it applies immediately).

ALTER TABLE topics ADD COLUMN effort TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (33, '033-topic-effort', datetime('now'));

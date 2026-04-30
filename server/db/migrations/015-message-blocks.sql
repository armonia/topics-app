-- Unified content-blocks timeline for assistant messages.
--
-- Why: thinking, text, and tool calls used to live in three separate buckets
-- on the message (`thinking` TEXT, `content` TEXT, `tool_calls` JSON). The
-- client rendered them in fixed bucket order — thinking → tools → text — so
-- a model that reasoned, called a tool, then reasoned again, lost its
-- chronological order and read as "all reasoning" + "all tools" + "all
-- prose". This column captures the actual arrival order as a JSON array of
-- `ContentBlock` items: { kind: 'text'|'thinking', text } | { kind: 'tool',
-- toolCall }. Consecutive same-kind deltas are coalesced into a single block.
--
-- Old rows have NULL blocks; the client falls back to the legacy bucket
-- rendering for those, so no backfill is needed.
ALTER TABLE messages ADD COLUMN blocks TEXT;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (15, '015-message-blocks', datetime('now'));

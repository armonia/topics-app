-- Compaction markers — first-class, display-only record of a Claude Code
-- context-compaction boundary (CHAT-COMPACT-01).
--
-- Kept in its OWN table (not the `messages` table) on purpose:
--   * it never touches the `messages.role` CHECK (user|assistant only);
--   * it never enters `build-provider-history` (the context re-sent to the
--     model) — the marker is display-only;
--   * it is positioned in the transcript by the id of the message it follows,
--     so the client renders a "context compacted" divider in the right spot.
CREATE TABLE IF NOT EXISTS compaction_markers (
  id               TEXT PRIMARY KEY,
  topic_id         TEXT,
  session_key      TEXT NOT NULL,
  after_message_id TEXT,
  trigger          TEXT NOT NULL DEFAULT 'unknown',
  pre_tokens       INTEGER,
  post_tokens      INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compaction_markers_session ON compaction_markers(session_key);
CREATE INDEX IF NOT EXISTS idx_compaction_markers_topic ON compaction_markers(topic_id);

-- 023-claude-code-sessions-fk.sql: add FK CASCADE on claude_code_sessions to
-- topics.session_key. Without this, deleting a topic left its CLI session
-- UUID row behind forever; on the off-chance another topic was later created
-- with the same sessionKey shape, `--resume` would target the WRONG dead
-- session. SQLite can't ALTER an existing table to add a FK, so we recreate
-- the table and copy non-orphan rows.
--
-- Foreign keys must be ON in db.ts (PRAGMA foreign_keys = ON, set in db.ts:26)
-- for the CASCADE to fire — the migration sets up the constraint either way.

-- 1. Drop orphan rows up front so the FK creation doesn't fail. (claude_code
--    rows whose session_key has no matching topic — possible if someone
--    inserted manually or if migration 022 saved a row before the topic was
--    created in a half-finished bootstrap.)
DELETE FROM claude_code_sessions
WHERE session_key NOT IN (SELECT session_key FROM topics);

-- 2. New table with FK and CASCADE on delete.
CREATE TABLE claude_code_sessions_new (
  session_key TEXT PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
);

-- 3. Copy preserved rows.
INSERT INTO claude_code_sessions_new (session_key, claude_session_id, created_at, updated_at)
SELECT session_key, claude_session_id, created_at, updated_at FROM claude_code_sessions;

-- 4. Drop old, rename new.
DROP TABLE claude_code_sessions;
ALTER TABLE claude_code_sessions_new RENAME TO claude_code_sessions;

-- 5. Recreate the index from migration 022 (lost when the table was dropped).
CREATE INDEX IF NOT EXISTS idx_claude_code_sessions_updated ON claude_code_sessions(updated_at);

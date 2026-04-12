-- Add status column to terminal_sessions for dormant session support.
-- 'active' = running PTY, 'dormant' = DB record without PTY (can be revived).
ALTER TABLE terminal_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

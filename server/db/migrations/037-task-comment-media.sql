-- 037: attachments on task comments (parity with chat messages.media).
-- JSON array of absolute file paths (from POST /api/upload); rendered through
-- the allowlist-gated /api/media endpoint, same as chat media.
ALTER TABLE task_comments ADD COLUMN media TEXT;

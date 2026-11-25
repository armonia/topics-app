-- The self-check round (change verifica-di-topics) reads the recent "moved to"
-- notes every 5 minutes. Without this index that read scanned every comment.
CREATE INDEX IF NOT EXISTS idx_task_comments_created_at ON task_comments(created_at);

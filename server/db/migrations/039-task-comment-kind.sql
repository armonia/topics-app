-- 039: task_comments.kind — the thread becomes a timeline.
--
-- 'comment' = a normal human/agent message (default, all existing rows).
-- 'status'  = a status-transition event ("todo→review", author = who moved it),
--             written by the service at EVERY status write (update, claim,
--             release, review decision) so the board answers "chi l'ha
--             spostato e quando" from the thread itself, between the comments.
ALTER TABLE task_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';

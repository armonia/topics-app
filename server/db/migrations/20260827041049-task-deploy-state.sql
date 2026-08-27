-- 20260827041049-task-deploy-state.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: that is what
-- makes collisions between parallel branches impossible. Do not rename it.
--
-- Where a card stands with the deploy proposed at approve (see
-- board_settings.deploy_command, migration 20260827041036). Persisted rather
-- than parsed back out of a comment, same reasoning as `landing_state`: a
-- state that only lives in free text disappears the moment somebody rewords
-- the sentence next to it.
--
--   deploy_state   NULL (never proposed) | 'proposed' | 'running' | 'deployed' | 'failed'
--   deploy_command_at_propose  the exact command shown at the time — a later
--                              settings edit must not change what "Deploya
--                              ora" is about to run out from under a pending
--                              proposal.
ALTER TABLE tasks ADD COLUMN deploy_state TEXT;
ALTER TABLE tasks ADD COLUMN deploy_command_at_propose TEXT;

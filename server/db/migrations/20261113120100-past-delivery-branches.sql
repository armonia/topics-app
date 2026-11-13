-- 20261113120100-past-delivery-branches.sql
--
-- tasks.past_delivery_branches: every delivery branch the card left behind when
-- it went back to the queue, space separated (a git branch name has no spaces).
-- `prior_branch` keeps only the latest one, so a card delivered three times lost
-- the first branch and the land counted its own older commits as foreign.
ALTER TABLE tasks ADD COLUMN past_delivery_branches TEXT;

-- 20261113120000-same-tip-redelivery-guard.sql
--
-- A resumed turn on a remote node can hand back the very commit that was just
-- sent back (13/11: the same tip three times in a row, one CI run each, with no
-- agent summary). `prior_commit` remembers the tip the card had when it left
-- review; `same_tip_bounces` counts consecutive system deliveries of that tip.
ALTER TABLE tasks ADD COLUMN prior_commit TEXT;
ALTER TABLE tasks ADD COLUMN same_tip_bounces INTEGER NOT NULL DEFAULT 0;

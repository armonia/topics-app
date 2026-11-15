-- 20261111174458-visible-preview-bounce-cap.sql
--
-- `deliverToReviewBySystem` bounces a `visibile` card with no real preview
-- back to `todo` so it never reaches review with only a placeholder diagram
-- (08/11, landed in 8de958b795). Without a cap that bounce is forever: the
-- card is reassigned, works a turn, hits the same gate, bounces again — 5
-- cards in 30 minutes on 11/11, burning turns no agent on this fleet can win
-- (no agent here can open a browser to shoot its own evidence).
--
-- `visible_preview_bounces` counts consecutive gate bounces. The cap (2) is
-- in code, not here: this column only remembers the count across turns.
ALTER TABLE tasks ADD COLUMN visible_preview_bounces INTEGER NOT NULL DEFAULT 0;


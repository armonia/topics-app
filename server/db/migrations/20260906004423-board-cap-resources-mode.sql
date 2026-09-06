-- 20260906004423-board-cap-resources-mode.sql
--
-- The prefix is a UTC timestamp (YYYYMMDDHHMMSS), not a counter: that is what
-- makes a collision between parallel cards impossible. Do not rename it.
--
-- THE CAP "BY RESOURCES", an alternative to the cap by number.
--
-- The concurrency cap counts agents. That is the right brake for the API bill
-- and the wrong one for the person sitting at the machine: three agents can be
-- nothing on an idle Mac and too many on one that is already compiling and on a
-- video call. This mode asks the other question, "is the machine under
-- pressure right now", against two thresholds the person chooses: load average
-- per core and memory used over total. The dispatcher admits a new agent only
-- while both stay under their threshold, and does not count agents at all.
--
-- Same reserved row '*' as the count cap and the spend caps: the brake belongs
-- to the machine, and one mode per board would be N modes on one machine.
--
-- All three columns are nullable and born NULL, which reads as "count mode with
-- the default thresholds" (see `readGlobalCap` and `capThresholds` in
-- shared/board.ts). No default written here on purpose: every install that
-- predates this migration keeps exactly the behaviour it had, and the
-- thresholds have ONE source of truth, the shared constants, not a copy in SQL.
ALTER TABLE board_settings ADD COLUMN max_agents_mode TEXT;

ALTER TABLE board_settings ADD COLUMN max_load_ratio REAL;

ALTER TABLE board_settings ADD COLUMN max_mem_ratio REAL;

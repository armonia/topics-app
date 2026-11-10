-- 20261110140000-stay-local-until.sql
--
-- When the "this Mac only" mark stops holding. NULL = for good (a person set
-- it). The dispatcher sets it after an empty run on a node: the pin answers to
-- the tools that node lacked, and those get installed (10/11: five cards stayed
-- pinned for hours after gh and git reached the PC's agents).
ALTER TABLE tasks ADD COLUMN stay_local_until TEXT;

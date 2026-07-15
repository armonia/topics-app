-- Configurable retry economy per board (was a hardcoded RETRY_CAP=3 constant).
--
-- ~1 dispatched task in 4 burns its whole budget without reaching review
-- (fuzzy/investigative work an agent can't close blind). Two knobs:
--   dispatch_retry_cap   — launch attempts before a task is parked. Default 2
--                          (down from 3): with cap 2 the "ULTIMO TURNO" deliver-
--                          -what-you-have nudge fires on the 2nd turn, so the
--                          human sees a partial sooner instead of paying a 3rd.
--   dispatch_retry_backoff_s — pause before resuming a turn that died faster
--                          than the backoff itself (an instant death is a
--                          provider outage, not work to redo). Default 60s.
-- NULL = the code default (2 / 60). Clamped in tasks.ts (cap 1-5, backoff
-- 10-600s).
ALTER TABLE board_settings ADD COLUMN dispatch_retry_cap INTEGER;
ALTER TABLE board_settings ADD COLUMN dispatch_retry_backoff_s INTEGER;

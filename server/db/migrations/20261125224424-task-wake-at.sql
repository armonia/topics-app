-- 20261125224424-task-wake-at.sql
--
-- «Rimanda a <data>»: a card parked in `backlog` with `wake_at` set returns to
-- `todo` on its own once that instant passes (card 975aba21). Before this, the
-- only way to get the same effect was an external script moving cards by hand
-- outside Topics.
--
-- wake_at: ISO instant, NULL = no pending wake. Writing any `status` without
-- `wakeAt` in the same PATCH clears it (server/services/tasks/status.ts).
ALTER TABLE tasks ADD COLUMN wake_at TEXT DEFAULT NULL;

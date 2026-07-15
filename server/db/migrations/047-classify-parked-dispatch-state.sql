-- Parked tasks used to collapse to dispatch_state = NULL, indistinguishable from
-- a task that was never dispatched (or a manual stop): the board could only show
-- a neutral "fermato". Reclassify the ones still sitting in backlog with a
-- dispatch_error into an explicit state so the card can render the right chip.
--
-- Only backlog rows with a NULL state and a real error are touched, so
-- requeued/live tasks are never disturbed. We classify by the KNOWN park reasons
-- (not a blanket catch-all) so a restart-victim isn't mislabeled a failure:
--
--  * 'blocked' — a config issue the human must fix (no worktree / project path
--    unresolvable). Amber "da sistemare".
--  * 'failed'  — a genuine agent failure (turn never reached review after the
--    cap / repeated setup errors). Red "fallito".
--
-- Deliberately NOT reclassified: the legacy "Il server è ripartito e i tentativi
-- sono esauriti" park — that was the restart-burns-budget bug (now fixed: a
-- restart requeues and refunds the attempt). Those rows are NOT failures; they
-- stay NULL and get requeued for a fair run rather than wearing a red chip.
UPDATE tasks SET dispatch_state = 'blocked'
 WHERE status = 'backlog' AND dispatch_state IS NULL AND dispatch_error IS NOT NULL
   AND (dispatch_error LIKE '%worktree%'
     OR dispatch_error LIKE '%directory del progetto%'
     OR dispatch_error LIKE '%repo git registrato%');

UPDATE tasks SET dispatch_state = 'failed'
 WHERE status = 'backlog' AND dispatch_state IS NULL AND dispatch_error IS NOT NULL
   AND (dispatch_error LIKE '%senza arrivare a review%'
     OR dispatch_error LIKE '%Avvio agent fallito%');

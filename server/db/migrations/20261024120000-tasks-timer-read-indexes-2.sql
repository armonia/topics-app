-- Two more reads of `tasks` on a timer walked the table: 44 of the 88 `[DB-SLOW]`
-- lines of 24/10/2026 (up to 1,288 ms). Partial indexes, as in 20261015200000.

-- The stale checks light, every 30 s: `clearStaleChecksRuns` reads the cards
-- whose light is running. Covering, so the plan never goes back to the table.
CREATE INDEX IF NOT EXISTS idx_tasks_checks_running ON tasks(id)
  WHERE checks_state = 'running';

-- The stuck parents, every 10 s: `sweepParkedChildren`. `archived` leads, as in
-- 20261015200000: alone, it loses to idx_tasks_archived. The predicate is the
-- one of PARKED_CHILDREN_CANDIDATES_SQL (server/lib/task-timer-reads.ts), word
-- for word: the planner only uses the index for the same text.
CREATE INDEX IF NOT EXISTS idx_tasks_parked_candidates ON tasks(archived, updated_at)
  WHERE archived = 0 AND status IN ('backlog', 'todo');

/**
 * The reads of `tasks` that run on a timer: the dispatcher tick, the wait
 * sweep, the status bar. They live here so server/db-sweep-plans.test.ts can
 * check their plans on the real schema (DBSLOW-03): each one has a partial
 * index (migration 20261015200000), and a full scan of `tasks` is ~1,400 pages.
 */
import { ACTIVE_DISPATCH_STATES } from "../../shared/board";

/** Boards with queued root cards: `rootsOnly` as in the dispatcher. */
export const QUEUED_ROOT_BOARDS_SQL = `SELECT DISTINCT project_id FROM tasks
          WHERE archived = 0 AND status = 'todo' AND parent_task_id IS NULL`;

export const WORKING_TASKS_COUNT_SQL = "SELECT COUNT(*) AS v FROM tasks WHERE dispatch_state = 'working'";

/** The board of the card that has been working the longest. */
export const OLDEST_WORKING_BOARD_SQL = `SELECT t.project_id AS v
         FROM tasks t
        WHERE t.dispatch_state = 'working' AND t.project_id IS NOT NULL
        ORDER BY t.in_progress_at ASC LIMIT 1`;

/** Cards parked in a wait series past the cutoff, oldest first. Binds: cutoff, now. */
export const PARKED_IN_SERIES_SQL = `SELECT id, project_id FROM tasks
            WHERE archived = 0
              AND status IN ('todo', 'in_progress')
              AND wait_since IS NOT NULL
              AND wait_since <= ?
              AND dispatch_deferred_until IS NOT NULL
              AND dispatch_deferred_until <= ?
            ORDER BY wait_since`;

/** Cards with a running checks light. Run by `clearStaleChecksRuns` every 30 s. */
export const CHECKS_RUNNING_SQL = "SELECT id FROM tasks WHERE checks_state = 'running'";

/**
 * The chips that say an agent is here or on its way, as a SQL list. Built from
 * the canonical list so it cannot drift from the one `services/tasks.ts` uses.
 */
const CHILD_AGENT_COMING = ACTIVE_DISPATCH_STATES.map((s) => `'${s}'`).join(", ");

/**
 * Parents that look stuck behind open children, read by `sweepParkedChildren`
 * on every dispatcher tick (10 s). Binds: now.
 */
export const PARKED_CHILDREN_CANDIDATES_SQL = `SELECT p.id, p.project_id FROM tasks p
            WHERE p.archived = 0
              AND p.status NOT IN ('done', 'review', 'in_progress')
              AND NOT (p.status = 'todo' AND p.dispatch_attempts = 0)
              AND COALESCE(p.dispatch_state, '') NOT IN (${CHILD_AGENT_COMING})
              AND COALESCE(p.dispatch_deferred_until, '') <= ?
              AND EXISTS (SELECT 1 FROM tasks c
                           WHERE c.parent_task_id = p.id AND c.archived = 0 AND c.status != 'done')
            ORDER BY p.updated_at`;

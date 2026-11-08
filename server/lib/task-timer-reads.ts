/**
 * The reads of `tasks` that run on a timer: the dispatcher tick, the wait
 * sweep, the status bar, the stale checks light, the stuck parents. They live
 * here so server/db-sweep-plans.test.ts can check their plans on the real
 * schema (DBSLOW-03). Each one has a partial index, and a full scan of `tasks`
 * is ~1,400 pages. The first four (queued roots, working count, oldest working
 * board, wait series) use indexes from migration 20261015200000; the checks
 * light and the stuck parents use those of 20261024120000.
 */
import { ACTIVE_DISPATCH_STATES } from "../../shared/board";

/** Boards with queued root cards: `rootsOnly` as in the dispatcher. */
export const QUEUED_ROOT_BOARDS_SQL = `SELECT DISTINCT project_id FROM tasks
          WHERE archived = 0 AND status = 'todo' AND parent_task_id IS NULL`;

/**
 * How many cards are working, for the status bar and the Discord presence.
 * `archived = 0`: archiving a working card leaves its `dispatch_state` as it
 * was, and an archived card must not keep "tasks running" lit. The unary `+`
 * keeps that term out of index selection: without it the planner picks
 * idx_tasks_archived and walks every live card instead of idx_tasks_working.
 */
export const WORKING_TASKS_COUNT_SQL =
  "SELECT COUNT(*) AS v FROM tasks WHERE dispatch_state = 'working' AND +archived = 0";

/** The board of the card that has been working the longest, archived cards excluded (`+` as above). */
export const OLDEST_WORKING_BOARD_SQL = `SELECT t.project_id AS v
         FROM tasks t
        WHERE t.dispatch_state = 'working' AND +t.archived = 0 AND t.project_id IS NOT NULL
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

/**
 * Root cards that sit in backlog with nobody on them and were last touched
 * before the cutoff, read by `sweepUnownedBacklog` on every reconcile (10 s).
 * Binds: cutoff. "Nobody" = no assignee, no agent topic, no blocker, no dispatch
 * chip (a parked card has its own announce); a person's own parking
 * (`created_by = 'human'`) is not unowned, unless it sits in TRIAGE (`stage`,
 * migration 20261030225403): there it is waiting for the triage pass, which is
 * the coordinator's job, whoever opened it. The `unowned_alerted_at` clause is the
 * dedupe: fire again only if the card was touched after the last alert.
 *
 * The first three terms are the predicate of idx_tasks_backlog_unowned
 * (migration 20261028163640), word for word: the planner uses a partial index
 * only for the same text.
 */
export const UNOWNED_BACKLOG_SQL = `SELECT id, project_id FROM tasks
            WHERE archived = 0
              AND status = 'backlog'
              AND parent_task_id IS NULL
              AND updated_at <= ?
              AND assigned_to IS NULL
              AND assigned_topic_id IS NULL
              AND blocked_by_task_id IS NULL
              AND dispatch_state IS NULL
              AND ((created_by IS NOT NULL AND created_by <> 'human') OR stage = 'triage')
              AND (unowned_alerted_at IS NULL OR unowned_alerted_at < updated_at)
            ORDER BY updated_at`;

/** Cards with a running checks light. Run by `clearStaleChecksRuns` every 30 s. */
export const CHECKS_RUNNING_SQL = "SELECT id FROM tasks WHERE checks_state = 'running'";

/**
 * The dispatch chips that say an agent is here or on its way, as a SQL list.
 * Built from `ACTIVE_DISPATCH_STATES` so it cannot drift from it.
 */
export const CHILD_AGENT_COMING = ACTIVE_DISPATCH_STATES.map((s) => `'${s}'`).join(", ");

/**
 * Parents that look stuck behind open children, read by `sweepParkedChildren`
 * on every dispatcher tick (10 s). Binds: now.
 *
 * `status IN ('backlog', 'todo')` is the same set as the old
 * `NOT IN ('done', 'review', 'in_progress')`, because the table's CHECK keeps
 * status to those five values. It must stay identical to the predicate of
 * idx_tasks_parked_candidates (migration 20261024120000), or the planner will
 * not use that index.
 *
 * A backlog parent that no turn ever touched (no attempt, never started, never
 * delivered, no dispatch chip left by one) is a CONTAINER: a person grouping cards under it, not a parent
 * stuck behind them. Measured 08/11: 15 grouping parents made in backlog, 11
 * pushed to review within one tick with a question nobody needed to answer.
 */
export const PARKED_CHILDREN_CANDIDATES_SQL = `SELECT p.id, p.project_id FROM tasks p
            WHERE p.archived = 0
              AND p.status IN ('backlog', 'todo')
              AND NOT (p.status = 'todo' AND p.dispatch_attempts = 0)
              AND NOT (p.status = 'backlog' AND p.dispatch_attempts = 0
                       AND p.in_progress_at IS NULL AND p.delivered_by IS NULL
                       AND p.dispatch_state IS NULL)
              AND COALESCE(p.dispatch_state, '') NOT IN (${CHILD_AGENT_COMING})
              AND COALESCE(p.dispatch_deferred_until, '') <= ?
              AND EXISTS (SELECT 1 FROM tasks c
                           WHERE c.parent_task_id = p.id AND c.archived = 0 AND c.status != 'done')
            ORDER BY p.updated_at`;
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala

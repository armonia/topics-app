/**
 * session-monitor — periodic, FREE "what needs attention" ping.
 *
 * Every N minutes it reads sessions with unread activity (one indexed query —
 * NO model call, NO `claude` invocation → no Agent SDK credit, stays free) and
 * broadcasts a `master:digest` so the client can show a proactive nudge. The
 * Master never reasons on a timer (that would cost — see
 * project_claude-billing-constraint); the reasoning stays one human tap away.
 *
 * interactive-claude-primitive — free monitor.
 */
import { buildAttentionDigest, type SessionStateRow } from "./session-digest";

export interface SessionMonitorDeps {
  db: { query: (sql: string) => { all: () => unknown[] } };
  broadcast: (msg: unknown) => void;
  /** Sweep interval. Default 5 min. */
  intervalMs?: number;
  /** Injectable clock for tests (ms). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Build the attention digest from current unread state (one query, free). */
export function sweepOnce(deps: Pick<SessionMonitorDeps, "db">): ReturnType<typeof buildAttentionDigest> {
  let rows: { id: string; name: string; unread: number }[] = [];
  try {
    rows = deps.db.query(
      `SELECT t.id AS id, t.name AS name, u.unread_count AS unread
       FROM topics t JOIN unread u ON u.topic_id = t.id
       WHERE t.archived = 0 AND u.unread_count > 0`
    ).all() as { id: string; name: string; unread: number }[];
  } catch {
    rows = [];
  }
  const sessions: SessionStateRow[] = rows.map((r) => ({
    topicId: r.id,
    name: r.name,
    state: "update",
    unread: r.unread,
  }));
  return buildAttentionDigest(sessions);
}

/**
 * Start the periodic monitor. Returns a stop() function. Broadcasts
 * `master:digest` only when at least one session needs attention, so a quiet
 * workspace stays silent.
 */
export function startSessionMonitor(
  db: SessionMonitorDeps["db"],
  broadcast: SessionMonitorDeps["broadcast"],
  intervalMs: number = DEFAULT_INTERVAL_MS,
  now: () => number = () => Date.now(),
): () => void {
  const tick = () => {
    const digest = sweepOnce({ db });
    if (digest.count > 0) {
      broadcast({ type: "master:digest", ...digest, ts: now() });
    }
  };
  const handle = setInterval(tick, intervalMs);
  // Don't keep the process alive just for this timer.
  (handle as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}

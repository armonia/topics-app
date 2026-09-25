/**
 * WHO TAKES A TURN THE CLI OPENED BY ITSELF.
 *
 * A `Monitor` (or a background shell) delivers its event by opening a new turn
 * nobody asked for; `ClaudeCodeProvider.observeWokenTurns` hands the server the
 * session key and this decides whether the server adopts it into a chat row.
 *
 * The rule lives here, pure, because it is the one the server got wrong: it
 * refused every archived topic, and the topics of task agents are born archived
 * (`createDetachedTopic` with `background: true`). So a Monitor armed inside a
 * running task never woke its agent: 8 of 88 wakes dropped since 16/09, all on
 * topics whose task was in progress at that moment.
 *
 * An archived topic owned by an `in_progress` task is alive: the same rule
 * `reconcileArchivedTopicSessions` already applies to its session phase. Any
 * other archived topic is still refused, for the original reason (c8a6b0ac9):
 * adopting would write a row into a chat the user no longer has.
 */

export type WakeVerdict = "adopt" | "no-topic" | "archived";

export function wakeVerdict(
  topic: { id: string; archived?: boolean } | null,
  ownedByRunningTask: (topicId: string) => boolean,
): WakeVerdict {
  if (!topic) return "no-topic";
  if (!topic.archived) return "adopt";
  // Asked only for archived topics: an open one needs no query, and the wake
  // runs on the stream hot path.
  return ownedByRunningTask(topic.id) ? "adopt" : "archived";
}

/** The smallest slice of `bun:sqlite` this needs, so tests pass an in-memory db. */
interface QueryDb {
  query(sql: string): { get(...params: string[]): unknown };
}

/**
 * Is `topicId` the topic of a task currently in progress? A failing query
 * answers `false`: refusing a wake loses one answer, while adopting on a guess
 * could write into a chat nobody owns.
 *
 * Two ways to own it. `tasks.assigned_topic_id` names attempt 1 only: in a
 * fan-out, attempts 2..N live in `task_attempts` (state `running` while their
 * turn is alive), with topics born archived like any agent's, and a Monitor on
 * one of them was dropped (adversarial check on bd0525bcb, 24/09).
 */
export function runningTaskOwnsTopic(db: QueryDb, topicId: string): boolean {
  try {
    const assigned = db.query(
      "SELECT 1 FROM tasks WHERE status = 'in_progress' AND assigned_topic_id = ? LIMIT 1",
    ).get(topicId) != null;
    if (assigned) return true;
  } catch (err) {
    console.warn(`[wake] task ownership lookup failed for ${topicId}:`, err);
    return false;
  }
  try {
    return db.query(
      `SELECT 1 FROM task_attempts a JOIN tasks t ON t.id = a.task_id
        WHERE a.topic_id = ? AND a.state = 'running' AND t.status = 'in_progress' LIMIT 1`,
    ).get(topicId) != null;
  } catch {
    // No `task_attempts` table (an older database): there are no attempts to own it.
    return false;
  }
}

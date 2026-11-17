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
 *
 * A second proof of life, for the wakes that answer something the chat itself
 * launched (a sub-agent's result, a command's exit, a card's outcome): the
 * chat launched it AFTER it was archived. Channel chats (a person's WhatsApp
 * or Discord thread driven by a bridge) are archived to stay out of the
 * sidebar and keep working for weeks; on 17/11 such a parent spawned a child,
 * the child finished, and the archived verdict wrote the result as a plain row:
 * the parent never read it. A chat a person archived AFTER the launch is still
 * refused, because the person closed it with the work in flight.
 */

export type WakeVerdict = "adopt" | "no-topic" | "archived" | "stopped";

/**
 * `stopped`: the chat of a sub-agent its parent or a person stopped. Nothing
 * that lands afterwards (a grandchild's result, a command's exit) wakes it,
 * archived or not: only an explicit `send_to_agent` starts it again. Read off
 * the row's state, because a stopped child's chat stays open to be read.
 */
export function wakeVerdict(
  topic: { id: string; archived?: boolean } | null,
  ownedByRunningTask: (topicId: string) => boolean,
  stoppedChild: (topicId: string) => boolean,
  launchedSinceRetired?: (topicId: string) => boolean,
): WakeVerdict {
  if (!topic) return "no-topic";
  if (stoppedChild(topic.id)) return "stopped";
  if (!topic.archived) return "adopt";
  // Asked only for archived topics: an open one needs no query, and the wake
  // runs on the stream hot path.
  if (ownedByRunningTask(topic.id)) return "adopt";
  return launchedSinceRetired?.(topic.id) ? "adopt" : "archived";
}

/** The smallest slice of `bun:sqlite` this needs, so tests pass an in-memory db. */
interface QueryDb {
  query(sql: string): { get(...params: string[]): unknown };
}

/** Is `topicId` the chat of a native sub-agent in state `stopped`? Its topic id is the child's id. */
export function stoppedSubagentChat(db: QueryDb, topicId: string): boolean {
  try {
    return db.query("SELECT 1 FROM subagents WHERE id = ? AND runtime = 'topics' AND state = 'stopped' LIMIT 1").get(topicId) != null;
  } catch {
    // No `subagents` table (an older database): no child to have stopped.
    return false;
  }
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

/**
 * When did this chat last launch work whose outcome comes back to it: a
 * sub-agent it spawned, or a card it opened? ISO time, or null when it
 * launched nothing. (A command's start is passed by its own wake: commands
 * are not rows.)
 */
export function lastLaunchFrom(db: QueryDb, topicId: string, sessionKey: string): string | null {
  const latest = (sql: string, ...params: string[]): string | null => {
    try {
      const row = db.query(sql).get(...params) as { at: string | null } | null;
      return row?.at ?? null;
    } catch {
      // A table an older database lacks: nothing launched through it.
      return null;
    }
  };
  const agents = latest("SELECT MAX(created_at) AS at FROM subagents WHERE parent_session_key = ?", sessionKey);
  const opened = latest("SELECT MAX(created_at) AS at FROM tasks WHERE created_by_topic_id = ?", topicId);
  const origin = latest("SELECT MAX(created_at) AS at FROM tasks WHERE origin_topic_id = ?", topicId);
  return [agents, opened, origin].reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null);
}

/**
 * Is an archived chat alive because it launched work after it was archived?
 * `launchedAt` is the launch the wake answers when the caller knows it (a
 * command's start); otherwise the chat's latest launch. Archive time comes
 * from `retirements` (the person's archive writes it with the date). With no
 * date nothing proves the archive came BEFORE the launch, and refusing is the
 * safe side: it is the old verdict.
 */
export function launchedSinceRetired(db: QueryDb, topicId: string, sessionKey: string, launchedAt?: string | null): boolean {
  const launch = launchedAt ?? lastLaunchFrom(db, topicId, sessionKey);
  if (!launch) return false;
  let retiredAt: string | null = null;
  try {
    const row = db.query("SELECT retired_at AS at FROM retirements WHERE kind = 'topic' AND ref_id = ? LIMIT 1").get(topicId) as { at: string } | null;
    retiredAt = row?.at ?? null;
  } catch {
    // No `retirements` table (an older database): no archive date to compare.
  }
  return retiredAt !== null && launch > retiredAt;
}

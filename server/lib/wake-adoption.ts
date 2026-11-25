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
 * The launch a wake answers. Each carries the proof the server wrote when the
 * chat launched it, never a field the caller declared:
 *  - `subagentId`: `subagents.parent_session_key` is set by the spawn itself;
 *  - `taskId`: `tasks.created_by_topic_id` is set "only by the server from a
 *    resolved session" (migrations/20261103130000-task-card-origin.sql:13),
 *    unlike `origin_topic_id`, which a caller names freely and which
 *    `routes/tasks-board.ts:576-581` says "must never grant closing power";
 *  - `startedAt`: the command's own start, passed by its wake.
 */
export type WakeLaunch = { subagentId: string } | { taskId: string } | { startedAt: string };

/**
 * The `retirements.reason` values that a PERSON (or the interface acting for
 * one) writes: the archive (`routes/topics-update.ts`), the bulk archive, the
 * closed tab. Whoever archives on the system's behalf writes a reason of its
 * own: `task-release` (the dispatcher letting a card go), `subagent-end` (a
 * native child at the end of its turn), `reconcile:archived`, `attempt-reap`,
 * and `reconcile:registry`, which stamps at the first restart, with the
 * restart's date, the chats of board agents that are BORN archived
 * (`session-control-core.ts:215`, `retirement.ts:313`). `backfill:archived`
 * dates what was archived before the table existed, whoever did it.
 */
export const PERSON_ARCHIVE_REASONS = ["archive", "bulk-archive", "tab-close"] as const;

function launchTime(db: QueryDb, topicId: string, sessionKey: string, launch: WakeLaunch): string | null {
  const at = (sql: string, ...params: string[]): string | null => {
    try {
      return (db.query(sql).get(...params) as { at: string | null } | null)?.at ?? null;
    } catch {
      // A table an older database lacks: nothing was launched through it.
      return null;
    }
  };
  if ("startedAt" in launch) return launch.startedAt;
  if ("subagentId" in launch) return at("SELECT created_at AS at FROM subagents WHERE id = ? AND parent_session_key = ?", launch.subagentId, sessionKey);
  return at("SELECT created_at AS at FROM tasks WHERE id = ? AND created_by_topic_id = ?", launch.taskId, topicId);
}

/**
 * Marks `topicId` as a chat the system created for work (a card's agent, an
 * attempt of a fan-out, a native child). Written once, at birth, by whoever
 * creates the chat; no later requeue, park or relaunch removes it.
 */
export function markSystemChat(db: { run(sql: string, params?: unknown[]): unknown }, topicId: string, kind: "task" | "attempt" | "subagent"): void {
  try {
    db.run("INSERT OR IGNORE INTO system_chats (topic_id, kind, created_at) VALUES (?, ?, ?)", [topicId, kind, new Date().toISOString()]);
  } catch {
    // A database without the table (an older test schema): nothing to mark.
  }
}

/** Is `topicId` a chat the system created for work, never one a person opened? */
export function isSystemChat(db: QueryDb, topicId: string): boolean {
  try { return db.query("SELECT 1 FROM system_chats WHERE topic_id = ? LIMIT 1").get(topicId) != null; } catch { return false; }
}

/**
 * Is an archived chat alive for THIS wake? Yes when the work the wake answers
 * was launched by the chat after a person archived it. Anything else is the
 * old verdict (false): no launch given, no row proving the chat launched it,
 * no archive row written by a person (a chat born archived has none), or a
 * person archiving the chat after the launch.
 */
export function launchedSinceRetired(db: QueryDb, topicId: string, sessionKey: string, launch?: WakeLaunch): boolean {
  if (!launch) return false;
  // Before the reason existed the dispatcher and the native children archived
  // as "archive" too (93 card agents on the live database on 17/11): a chat the
  // system itself made is never one a person archived and went on using.
  if (isSystemChat(db, topicId)) return false;
  const launchedAt = launchTime(db, topicId, sessionKey, launch);
  if (!launchedAt) return false;
  try {
    const marks = PERSON_ARCHIVE_REASONS.map(() => "?").join(", ");
    const row = db.query(
      `SELECT retired_at AS at FROM retirements WHERE kind = 'topic' AND ref_id = ? AND reason IN (${marks}) LIMIT 1`,
    ).get(topicId, ...PERSON_ARCHIVE_REASONS) as { at: string } | null;
    return !!row && launchedAt > row.at;
  } catch {
    // No `retirements` table (an older database): no archive date to compare.
    return false;
  }
}

/**
 * The `canWake` the launch-answering wakes share (sub-agent results and card
 * outcomes): one verdict per launch, from the topic's
 * row, its owner task, its stopped state and, for an archived chat, the launch
 * after a person's archive. `wait` while the provider is held.
 */
export function launchingChatCanWake(deps: {
  db: QueryDb;
  getTopicBySessionKey(sessionKey: string): { id: string; archived?: boolean; provider?: string | null } | null | undefined;
  isProviderHeld(provider: string): boolean;
  defaultProvider(): string | undefined;
}): (sessionKey: string, launch?: WakeLaunch) => "wake" | "wait" | "row" {
  return (sk, launch) => {
    const topic = deps.getTopicBySessionKey(sk);
    if (!topic) return "row";
    const verdict = wakeVerdict(
      { id: topic.id, archived: topic.archived },
      (id) => runningTaskOwnsTopic(deps.db, id),
      (id) => stoppedSubagentChat(deps.db, id),
      (id) => launchedSinceRetired(deps.db, id, sk, launch),
    );
    if (verdict !== "adopt") return "row";
    return deps.isProviderHeld(topic.provider || deps.defaultProvider() || "claude-code") ? "wait" : "wake";
  };
}

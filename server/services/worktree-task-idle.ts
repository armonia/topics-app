/**
 * HOW LONG A TASK HAS BEEN SILENT, for the abandon rule of the worktree GC.
 * Moved out of `worktree-gc-runner.ts` (which re-exports `taskIdleDays`) to keep
 * that file under the size gate; the logic is unchanged.
 */
import { existsSync, statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Topic } from "../types";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";

/**
 * The transcript mtime of a task's topic, or null. The only trace of a session
 * that writes without ever reaching our tables; best effort by design: a missing
 * file, a topic without a Claude session id or an unreadable cwd simply do not vote.
 */
export function transcriptMtime(
  deps: { db: Database; getTopicBySessionKey: (sessionKey: string) => Topic | null; resolveTopicCwd: (topic: Topic | null | undefined) => string | null },
  topicId: string,
): number | null {
  try {
    const sk = (deps.db.prepare("SELECT session_key AS sk FROM topics WHERE id = ?")
      .get(topicId) as { sk?: string } | undefined)?.sk;
    const topic = sk ? deps.getTopicBySessionKey(sk) : null;
    const claudeSessionId = sk
      ? (deps.db.prepare("SELECT claude_session_id AS id FROM claude_code_sessions WHERE session_key = ?")
          .get(sk) as { id?: string } | undefined)?.id
      : undefined;
    const cwd = topic ? deps.resolveTopicCwd(topic) : null;
    if (!cwd || !claudeSessionId) return null;
    const p = claudeTranscriptPath(cwd, claudeSessionId);
    return existsSync(p) ? statSync(p).mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Days since the LAST SIGN OF LIFE on a task, or null if we cannot tell.
 *
 * "Life" is the maximum over every trace WORK leaves, because each alone has a
 * blind spot: comments miss a chat-only session, messages miss a turn that only
 * committed, and both miss a CLI session whose only trace is its transcript
 * growing on disk. A query that fails returns null, which the GC reads as
 * "don't touch".
 *
 * What does NOT count: `tasks.updated_at` (the dispatcher rewrites it every 60 s
 * while it holds a card, so the more stuck a card was the fresher it looked:
 * measured 17/09/2026, 8 `in_progress` cards of 8 under 10 minutes old, 6 of them
 * silent for 2 days) and the dispatcher's own bookkeeping comments
 * (`kind IN ('service','status')`).
 */
export function taskIdleDays(
  db: Database,
  taskId: string,
  transcriptAt?: (topicId: string) => number | null,
): number | null {
  try {
    const row = db
      .prepare(
        `SELECT (SELECT MAX(created_at) FROM task_comments
                   WHERE task_id = t.id AND COALESCE(kind, 'comment') NOT IN ('service', 'status')) AS commentAt,
                (SELECT MAX(m.timestamp) FROM messages m
                   JOIN topics tp ON tp.session_key = m.session_key
                  WHERE tp.id = t.assigned_topic_id) AS messageAt,
                t.assigned_topic_id AS topicId
           FROM tasks t WHERE t.id = ?`,
      )
      .get(taskId) as { commentAt?: string; messageAt?: string; topicId?: string } | undefined;
    if (!row) return null;

    let last = 0;
    for (const ts of [row.commentAt, row.messageAt]) {
      const ms = ts ? Date.parse(ts) : NaN;
      if (Number.isFinite(ms)) last = Math.max(last, ms);
    }

    // An attempt is a turn that really ran: the one trace a fan-out leaves when
    // the losing agents said nothing. Its own query, because a DB without the
    // table (an older test fixture) must cost a vote, never turn the answer into
    // null, which would hide the very staleness being measured.
    try {
      const attempt = db
        .prepare("SELECT MAX(MAX(COALESCE(ended_at, ''), COALESCE(created_at, ''))) AS at FROM task_attempts WHERE task_id = ?")
        .get(taskId) as { at?: string } | undefined;
      const ms = attempt?.at ? Date.parse(attempt.at) : NaN;
      if (Number.isFinite(ms)) last = Math.max(last, ms);
    } catch { /* one vote fewer, never a block */ }

    if (row.topicId && transcriptAt) {
      const ms = transcriptAt(row.topicId);
      if (ms != null && Number.isFinite(ms)) last = Math.max(last, ms);
    }

    if (!last) return null;
    return (Date.now() - last) / 86_400_000;
  } catch (err) {
    console.warn("[worktree-gc] idleDays failed", err);
    return null;
  }
}

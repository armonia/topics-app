/**
 * WHERE THE STORE READS ITS RE-READ INPUTS AT EVERY START (notifications-
 * redesign, design section 7): the `AttentionBootReader` the server hands to
 * `recomposeAttentionOnBoot`, from the database and the live registries.
 *
 * Out of `server.ts` so the readings that decide whether a restart is a death
 * are tested against a real database: a chat waiting on its own `run_command`
 * is not dead because its CLI is (review 2, B3), and a plan panel still on its
 * row is a wait that survived the restart (review 2, B4).
 */
import type { Database } from "bun:sqlite";
import { terminalIdOfSubject, topicIdOfSubject } from "../../shared/attention";
import { recentActiveRows, type ActiveRowsSource } from "../lib/ask-answer-routing";
import { toolCallWaitingOnRows } from "../lib/question-outlives-asker";
import type { AttentionBootReader } from "./store";

export interface AttentionBootSources extends ActiveRowsSource {
  db: Database & ActiveRowsSource["db"];
  getTopicById: (id: string) => { sessionKey?: string | null; archived?: boolean } | null | undefined;
  /** The CLI of this session still holds work or a wake (`sessionHasBackgroundWork`). */
  cliHasWork: (sessionKey: string) => boolean;
  /** A Topics `run_command` of this session still owes it a wake (`commandWakeState` not `none`). */
  commandOwesWake: (sessionKey: string) => boolean;
  /** The chat subjects of the board agents in flight (dispatcher). */
  dispatchedSubjects: () => string[];
  decode: (value: unknown) => string | null | undefined;
}

export function attentionBootReader(src: AttentionBootSources): AttentionBootReader {
  const sessionOf = (subject: string): string | null => {
    const topicId = topicIdOfSubject(subject);
    return topicId ? src.getTopicById(topicId)?.sessionKey ?? null : null;
  };
  return {
    liveProcess: (subject) => {
      if (topicIdOfSubject(subject)) {
        const sk = sessionOf(subject);
        return !!sk && src.cliHasWork(sk);
      }
      const terminalId = terminalIdOfSubject(subject);
      if (terminalId) {
        const row = src.db.query("SELECT status FROM terminal_sessions WHERE id = ?").get(terminalId) as { status?: string } | null;
        return !!row && row.status !== "dormant";
      }
      return true;
    },
    commandOwed: (subject) => {
      const sk = sessionOf(subject);
      return !!sk && src.commandOwesWake(sk);
    },
    planWaiting: (subject, toolCallId) => {
      const sk = sessionOf(subject);
      if (!sk) return false;
      try { return toolCallWaitingOnRows(recentActiveRows(src, sk), toolCallId, src.decode); } catch { return false; }
    },
    cards: () => (src.db.query(
      `SELECT id, status, dispatch_error, review_at, updated_at FROM tasks
        WHERE archived = 0 AND (status = 'review' OR (status = 'backlog' AND dispatch_state IN ('failed', 'blocked', 'waited_out')))`,
    ).all() as Array<{ id: string; status: string; dispatch_error: string | null; review_at: string | null; updated_at: string }>)
      .map((r) => r.status === "review"
        ? { taskId: r.id, status: "review" as const, since: r.review_at ?? r.updated_at }
        : { taskId: r.id, status: "parked" as const, since: r.updated_at, detail: r.dispatch_error }),
    archived: (subjects) => new Set(subjects.filter((subject) => {
      const topicId = topicIdOfSubject(subject);
      if (!topicId) return false;
      const topic = src.getTopicById(topicId);
      return !topic || !!topic.archived;
    })),
    closed: (subjects) => new Set(subjects.filter((subject) => {
      const terminalId = terminalIdOfSubject(subject);
      if (!terminalId) return false;
      return !src.db.query("SELECT 1 FROM terminal_sessions WHERE id = ?").get(terminalId);
    })),
    dispatched: src.dispatchedSubjects,
  };
}

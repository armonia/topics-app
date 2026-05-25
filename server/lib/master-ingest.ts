/**
 * master-ingest — upsert a Master lead's `## Next` proposals into the kanban.
 *
 * Extracted from the /api/topics/master/ingest route so the upsert + task_events
 * + dedupe logic is unit-testable against a real SQLite schema (bun:test).
 * See refactor-master-into-kanban (AD-3/AD-4).
 */

import type { Database } from "bun:sqlite";
import { parseNextActions, type NextSessionRef } from "./master-next-parser";
import { GLOBAL_BOARD_ID, isTopicRef, proposalStatus, proposalTaskId } from "./master-proposals";

export interface IngestDeps {
  db: Database;
  /** Resolve a referenced topic id → project id (null if it has no project). */
  resolveProjectId: (topicId: string) => string | null;
  /** WS broadcast sink (task:created / task:updated). */
  broadcast: (msg: unknown) => void;
  /** The lead topic id — used as task_events.topic_id (always a valid FK). */
  leadTopicId: string;
  /** Sessions the proposals may bind to (topics + claude-code terminals). */
  sessions: NextSessionRef[];
  /** The lead's latest assistant message content. */
  content: string;
}

export interface IngestUpsert {
  projectId: string;
  verb: "completa" | "apri";
  ref: string;
  taskId: string;
  created: boolean;
}

export interface IngestResult {
  proposals: number;
  upserted: IngestUpsert[];
}

/**
 * Parse the content's `## Next` block and upsert one proposal card per session
 * (keyed by claude_task_id). Idempotent: re-emitting updates the same card.
 */
export function runMasterIngest(deps: IngestDeps): IngestResult {
  const { db, resolveProjectId, broadcast, leadTopicId, sessions, content } = deps;
  const proposals = parseNextActions(content, sessions);
  const now = new Date().toISOString();
  const upserted: IngestUpsert[] = [];

  for (const p of proposals) {
    const claudeTaskId = proposalTaskId(p.topicId);
    const status = proposalStatus(p.verb);
    // assigned_topic_id REFERENCES topics(id) — only for real topics; terminal
    // refs (terminal:<id>) are not topics. chat_id holds the jump ref for both.
    const assignedTopicId = isTopicRef(p.topicId) ? p.topicId : null;
    const projectId = (assignedTopicId ? resolveProjectId(assignedTopicId) : null) || GLOBAL_BOARD_ID;
    const completedAt = status === "done" ? now : null;
    const text = p.reason || "(proposta)";

    const existing = db.prepare("SELECT id FROM tasks WHERE claude_task_id = ?").get(claudeTaskId) as { id: string } | undefined;
    let taskId: string;
    const created = !existing;
    if (existing) {
      taskId = existing.id;
      db.prepare(
        "UPDATE tasks SET text = ?, status = ?, chat_id = ?, assigned_topic_id = ?, completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(text, status, p.topicId, assignedTopicId, completedAt, now, taskId);
    } else {
      taskId = crypto.randomUUID();
      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) AS m FROM tasks WHERE project_id = ?").get(projectId) as { m: number } | undefined;
      db.prepare(
        "INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, due_date, chat_id, created_at, completed_at, updated_at, claude_task_id, assigned_topic_id) VALUES (?, ?, ?, NULL, ?, 2, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)"
      ).run(taskId, projectId, text, status, (maxRow?.m ?? 0) + 1, p.topicId, now, completedAt, now, claudeTaskId, assignedTopicId);
    }

    // Reasoning-trail event. topic_id = the LEAD (always a valid FK); the real
    // session ref lives in the payload (terminals are not topics).
    db.prepare(
      "INSERT INTO task_events (claude_task_id, topic_id, ts, type, payload) VALUES (?, ?, ?, 'proposal', ?)"
    ).run(claudeTaskId, leadTopicId, Date.now(), JSON.stringify({ verb: p.verb, ref: p.topicId, reason: p.reason }));

    broadcast({
      type: created ? "task:created" : "task:updated",
      projectId,
      task: {
        id: taskId, text, description: null,
        status, priority: 2, kanbanOrder: 0,
        assignedTo: null, dueDate: null, chatId: p.topicId,
        createdAt: now, completedAt, updatedAt: now,
        claudeTaskId, assignedTopicId,
      },
    });
    upserted.push({ projectId, verb: p.verb, ref: p.topicId, taskId, created });
  }

  return { proposals: proposals.length, upserted };
}

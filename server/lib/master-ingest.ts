/**
 * master-ingest — upsert a Master lead's `## Next` proposals into the kanban.
 *
 * Extracted from the /api/topics/master/ingest route so the upsert + task_events
 * + dedupe logic is unit-testable against a real SQLite schema (bun:test).
 * See refactor-master-into-kanban (AD-3/AD-4).
 */

import type { Database } from "bun:sqlite";
import { parseNextActions, parseNextRows, type NextSessionRef } from "./master-next-parser";
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
  /** The proposal source text: a full message (chat Master) OR an already-
   *  extracted `## Next` block body (terminal Master, scraped buffer). */
  content: string;
  /** True when `content` is an already-extracted block body (use parseNextRows,
   *  skip heading detection). Set by the terminal-buffer scrape path where the
   *  LAST block was already isolated. interactive-claude-primitive AD-2. */
  contentIsBlock?: boolean;
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
  const { db, resolveProjectId, broadcast, leadTopicId, sessions, content, contentIsBlock } = deps;
  const proposals = contentIsBlock
    ? parseNextRows(content, sessions)
    : parseNextActions(content, sessions);
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

    // Reasoning-trail event. topic_id was meant to be the lead, but a terminal
    // Master is NOT a topic (task_events.topic_id has an FK to topics.id). Use
    // the lead if it's a real topic, else the proposal's own topic, and wrap in
    // try/catch so a non-topic lead degrades the TRAIL only — the card is
    // already written. interactive-claude-primitive AD-2.
    const eventTopicId = isTopicRef(leadTopicId) ? leadTopicId : (assignedTopicId || leadTopicId);
    try {
      db.prepare(
        "INSERT INTO task_events (claude_task_id, topic_id, ts, type, payload) VALUES (?, ?, ?, 'proposal', ?)"
      ).run(claudeTaskId, eventTopicId, Date.now(), JSON.stringify({ verb: p.verb, ref: p.topicId, reason: p.reason }));
    } catch {
      // FK miss (lead is a terminal, no topic ref) — skip the trail row, keep the card.
    }

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

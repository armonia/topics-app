/**
 * tasks.ts — the single task service (Phase 0 of kanban-agent-authoring).
 *
 * Single writer for the `tasks` + `task_comments` + `approvals` tables. It exists
 * to collapse three divergent write paths (the inline INSERT in `routes/chat.ts`,
 * the `claude-tasks-sync.ts` file-watcher, and the MCP/board routes) onto ONE
 * point that enforces the invariants.
 *
 * Hard invariant (KANBAN-05): an `actor: "agent"` may NEVER move a task to
 * `done`. It hands off to `review`, opening an `approvals(approval_type='review')`
 * row; only an `actor: "human"` closes `review → done`. The gate holds even when
 * `board_settings.require_approval_for_done` is off — it is a property of the
 * actor, not a board setting.
 *
 * Idempotency (KANBAN-03): `create({ idempotencyKey })` writes the key into
 * `tasks.claude_task_id` (UNIQUE, partial index — migration 026), the same
 * key-space the file-watcher uses, so a task created via MCP and the same task
 * seen by the watcher never split into two.
 *
 * The module is environment-pure: it takes the `Database` (bun:sqlite) plus
 * optional injectable `now`/`uuid`, so tests run on a deterministic `:memory:`
 * DB without booting the server.
 */
import type { Database } from "bun:sqlite";

export type TaskStatus = "backlog" | "todo" | "in_progress" | "review" | "done";
export type Actor = "human" | "agent";

const STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "review", "done"];

export interface Task {
  id: string;
  projectId: string;
  text: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  kanbanOrder: number;
  assignedTo: string | null;
  dueDate: string | null;
  chatId: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
  claudeTaskId: string | null;
  assignedTopicId: string | null;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  mentions: string[];
  createdAt: string;
}

export interface CreateTaskInput {
  projectId: string;
  text: string;
  description?: string | null;
  priority?: number;
  assignedTo?: string | null;
  status?: TaskStatus;
  chatId?: string | null;
  /** Optional dedupe key → tasks.claude_task_id (UNIQUE). */
  idempotencyKey?: string | null;
}

export interface UpdateTaskPatch {
  text?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: number;
  assignedTo?: string | null;
  dueDate?: string | null;
  kanbanOrder?: number;
}

export interface ListTasksInput {
  scope: "project" | "all";
  projectId?: string;
  status?: TaskStatus;
}

/** Recoverable, structured error — the route maps `.code` to an HTTP status. */
export class TaskServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "TaskServiceError";
  }
}

/**
 * Derive the board `project_id` from an absolute project path.
 *
 * BYTE-IDENTICAL to `getProjectIdForTopic` in `server/routes/topics.ts:720`
 * (djb2-ish 32-bit hash, base36, 6 chars, prefixed by the dir basename). Kept
 * duplicated here — not imported — because that helper is closure-local; a
 * parity test (`tasks.test.ts`) pins the two together. Do NOT "improve" the
 * hash without updating both, or existing rows orphan.
 */
export function projectIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, "").split("/");
  const dirName = parts[parts.length - 1] || "project";
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
}

interface ServiceOpts {
  now?: () => string;
  uuid?: () => string;
  /** Window within which an identical comment (same task+author+content) is deduped. */
  commentDedupeMs?: number;
}

export interface TaskService {
  create(input: CreateTaskInput): Task;
  get(taskId: string, opts?: { projectId?: string }): { task: Task; comments: TaskComment[] } | null;
  list(input: ListTasksInput): Task[];
  update(args: { taskId: string; actor: Actor; by: string; patch: UpdateTaskPatch; projectId?: string }): Task;
  addComment(args: { taskId: string; author: string; content: string; mentions?: string[]; projectId?: string }): TaskComment;
  /** Human-only review decision on a task sitting in `review`. */
  reviewDecision(args: { taskId: string; by: string; decision: "approve" | "reject"; comment?: string; projectId?: string }): Task;
  /** Soft-delete (archive) — the row stays for history but drops off the board. */
  archive(args: { taskId: string; projectId?: string }): Task;
}

export function createTaskService(db: Database, opts: ServiceOpts = {}): TaskService {
  const now = opts.now ?? (() => new Date().toISOString());
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const commentDedupeMs = opts.commentDedupeMs ?? 10_000;

  function rowToTask(r: any): Task {
    return {
      id: r.id,
      projectId: r.project_id,
      text: r.text,
      description: r.description ?? null,
      status: r.status,
      priority: r.priority,
      kanbanOrder: r.kanban_order,
      assignedTo: r.assigned_to ?? null,
      dueDate: r.due_date ?? null,
      chatId: r.chat_id ?? null,
      createdAt: r.created_at,
      completedAt: r.completed_at ?? null,
      updatedAt: r.updated_at,
      claudeTaskId: r.claude_task_id ?? null,
      assignedTopicId: r.assigned_topic_id ?? null,
    };
  }

  function rowToComment(r: any): TaskComment {
    let mentions: string[] = [];
    if (r.mentions) { try { mentions = JSON.parse(r.mentions); } catch { mentions = []; } }
    return { id: r.id, taskId: r.task_id, author: r.author, content: r.content, mentions, createdAt: r.created_at };
  }

  function getTaskRow(taskId: string): any {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  }

  return {
    create(input: CreateTaskInput): Task {
      const text = (input.text ?? "").trim();
      if (!text) throw new TaskServiceError("invalid_input", "task text is required");
      if (!input.projectId) throw new TaskServiceError("invalid_input", "projectId is required");

      const status = input.status ?? "todo";
      if (!STATUSES.includes(status)) throw new TaskServiceError("invalid_input", `invalid status "${status}"`);
      if (status === "done") throw new TaskServiceError("invalid_transition", "cannot create a task already done");

      // Idempotency: same key → return the existing task, no duplicate.
      if (input.idempotencyKey) {
        const existing = db.prepare("SELECT * FROM tasks WHERE claude_task_id = ?").get(input.idempotencyKey);
        if (existing) return rowToTask(existing);
      }

      const id = uuid();
      const ts = now();
      const priority = input.priority ?? 2;
      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(input.projectId) as any;
      const order = (maxRow?.m ?? 0) + 1;

      db.prepare(
        `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, chat_id, created_at, completed_at, updated_at, claude_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id, input.projectId, text, input.description ?? null, status, priority, order,
        input.assignedTo ?? null, input.chatId ?? null, ts, ts, input.idempotencyKey ?? null,
      );
      return rowToTask(getTaskRow(id));
    },

    get(taskId, opts) {
      const row = getTaskRow(taskId);
      if (!row) return null;
      if (opts?.projectId && row.project_id !== opts.projectId) return null;
      const comments = db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[];
      return { task: rowToTask(row), comments: comments.map(rowToComment) };
    },

    list(input: ListTasksInput): Task[] {
      const clauses: string[] = ["archived = 0"];
      const params: any[] = [];
      if (input.scope === "project") {
        if (!input.projectId) throw new TaskServiceError("invalid_input", "scope=project requires projectId");
        clauses.push("project_id = ?");
        params.push(input.projectId);
      }
      if (input.status) { clauses.push("status = ?"); params.push(input.status); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      // project scope → board order (status then kanban_order); global feed → recency.
      const order = input.scope === "all" ? "updated_at DESC" : "kanban_order ASC";
      const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY ${order}`).all(...params) as any[];
      return rows.map(rowToTask);
    },

    update({ taskId, actor, by, patch, projectId }): Task {
      const row = getTaskRow(taskId);
      // projectId guard: a session may only touch tasks on its own project.
      // A mismatch is reported as not_found (not 403) so cross-project ids stay
      // indistinguishable from non-existent ones.
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const current: TaskStatus = row.status;

      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) throw new TaskServiceError("invalid_input", `invalid status "${patch.status}"`);
        // The gate: an agent may never mark done — it hands off to review.
        if (patch.status === "done" && actor === "agent") {
          throw new TaskServiceError(
            "agent_cannot_complete",
            "agents deliver to 'review' for human approval; only a human moves 'review' → 'done'. Set status to 'review' instead.",
          );
        }
        // Agent entering review → open a pending review approval for the human.
        if (patch.status === "review" && actor === "agent" && current !== "review") {
          db.prepare(
            `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
             VALUES (?, ?, ?, 'review', ?, 'done', 'pending', ?)`,
          ).run(uuid(), taskId, by, current, now());
        }
      }

      const sets: string[] = [];
      const params: any[] = [];
      const put = (col: string, val: any) => { sets.push(`${col} = ?`); params.push(val); };

      if (patch.text !== undefined) put("text", patch.text);
      if (patch.description !== undefined) put("description", patch.description);
      if (patch.priority !== undefined) put("priority", patch.priority);
      if (patch.assignedTo !== undefined) put("assigned_to", patch.assignedTo);
      if (patch.dueDate !== undefined) put("due_date", patch.dueDate);
      if (patch.kanbanOrder !== undefined) put("kanban_order", patch.kanbanOrder);
      if (patch.status !== undefined) {
        put("status", patch.status);
        put("completed_at", patch.status === "done" ? now() : null);
      }
      put("updated_at", now());

      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, taskId);
      return rowToTask(getTaskRow(taskId));
    },

    addComment({ taskId, author, content, mentions, projectId }): TaskComment {
      const body = (content ?? "").trim();
      if (!body) throw new TaskServiceError("invalid_input", "comment content is required");
      const row = getTaskRow(taskId);
      // Same projectId guard as update() — no cross-project commenting.
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }

      // Dedupe identical author+content within the window — retries don't double-post.
      // Window boundary derives from the injected clock so tests are deterministic.
      const since = new Date(new Date(now()).getTime() - commentDedupeMs).toISOString();
      const dupe = db.prepare(
        "SELECT * FROM task_comments WHERE task_id = ? AND author = ? AND content = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
      ).get(taskId, author, body, since);
      if (dupe) return rowToComment(dupe);

      const id = uuid();
      const ts = now();
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, taskId, author, body, mentions && mentions.length ? JSON.stringify(mentions) : null, ts);
      return rowToComment(db.prepare("SELECT * FROM task_comments WHERE id = ?").get(id));
    },

    reviewDecision({ taskId, by, decision, comment, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      if (row.status !== "review") throw new TaskServiceError("invalid_transition", "task is not in review");
      const ts = now();

      // Resolve the pending review approval, if any.
      db.prepare(
        "UPDATE approvals SET status = ?, reviewed_by = ?, review_comment = ?, reviewed_at = ? WHERE task_id = ? AND approval_type = 'review' AND status = 'pending'",
      ).run(decision === "approve" ? "approved" : "rejected", by, comment ?? null, ts, taskId);

      if (comment && comment.trim()) {
        this.addComment({ taskId, author: by, content: comment });
      }

      const target: TaskStatus = decision === "approve" ? "done" : "in_progress";
      db.prepare("UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(target, target === "done" ? ts : null, ts, taskId);
      return rowToTask(getTaskRow(taskId));
    },

    archive({ taskId, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const ts = now();
      db.prepare("UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?").run(ts, taskId);
      return rowToTask(getTaskRow(taskId));
    },
  };
}

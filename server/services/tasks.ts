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
  /** null = never dispatched; queued | starting | working | needs_input. */
  dispatchState: string | null;
  dispatchAttempts: number;
  dispatchError: string | null;
  /** Parent task (nested subtask, unlimited depth). Set at creation only. */
  parentTaskId: string | null;
  /** Reviewable output (http/https URL) shown in the task's review panel. */
  outputUrl: string | null;
  /** Dispatch contract: deliver a PLAN to review before implementing. */
  planFirst: boolean;
  /** When the current claim started (dispatcher CAS) — the live "ci sta
   *  mettendo" ticker anchors here while a turn runs. */
  inProgressAt: string | null;
  /** Cumulative agent effort: wall-clock ms + tokens across every turn. */
  agentMs: number;
  agentTokens: number;
  /** Direct-children counters (filled by list/get for board badges). */
  subtaskCount: number;
  subtaskDoneCount: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  mentions: string[];
  /** Attached files: absolute paths from /api/upload, served via /api/media. */
  media: string[];
  createdAt: string;
  /**
   * 'comment' = a human/agent message. 'status' = a transition event written
   * by the service at every status write (content "from→to", author = who
   * moved it) — the thread doubles as the status history. Status events never
   * count as "the agent's last word" (review gate, delivered/needs_input chip).
   */
  kind: "comment" | "status";
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
  /**
   * Nest under this task (must exist, same project, not archived). Depth is
   * unbounded; cycles are impossible because the parent is set only here, at
   * creation — a fresh id can never be an ancestor of an existing row.
   */
  parentTaskId?: string | null;
  /** Dispatch contract: the agent delivers a PLAN to review before implementing. */
  planFirst?: boolean;
}

export interface UpdateTaskPatch {
  text?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: number;
  assignedTo?: string | null;
  dueDate?: string | null;
  kanbanOrder?: number;
  /** http(s) URL of the reviewable output; empty string / null clears it. */
  outputUrl?: string | null;
}

export interface ListTasksInput {
  scope: "project" | "all";
  projectId?: string;
  status?: TaskStatus;
  /**
   * Only ROOT tasks (parent_task_id IS NULL). The board columns and the
   * dispatcher use this: subtasks are a parent's checklist — they live in the
   * detail tree and the "↳ n/m" counter, never as their own cards, and the
   * dispatcher must never claim a step as an independent task.
   */
  rootsOnly?: boolean;
}

/** Per-board dispatch config (mirrors the `board_settings` row). */
export interface BoardSettings {
  projectId: string;
  /**
   * GLOBAL start switch (reserved row `project_id='*'`), surfaced here so
   * every per-board read keeps gating dispatch without knowing about the
   * global row. Writing it through updateBoardSettings flips it for ALL boards.
   */
  autoDispatch: boolean;
  /** Concurrency cap = max tasks running an agent at once on this board. */
  maxAgents: number;
  dispatchEffort: string;
  dispatchUseWorktree: boolean;
  dispatchTimeoutMin: number;
  requireApprovalForDone: boolean;
  requireReviewBeforeDone: boolean;
}

export interface UpdateBoardSettingsPatch {
  autoDispatch?: boolean;
  maxAgents?: number;
  dispatchEffort?: string;
  dispatchUseWorktree?: boolean;
  dispatchTimeoutMin?: number;
}

const VALID_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
const clampInt = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.trunc(Number.isFinite(n) ? n : lo)));

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
  get(taskId: string, opts?: { projectId?: string }): { task: Task; comments: TaskComment[]; children: Task[] } | null;
  list(input: ListTasksInput): Task[];
  /**
   * `agentTopicId` (session surface only) identifies the calling agent's chat
   * topic: it unlocks the "own steps" carve-out — an agent MAY mark `done` a
   * strict descendant of the task bound to its topic (its own checklist),
   * while the KANBAN-05 gate keeps protecting the deliverable itself.
   */
  update(args: { taskId: string; actor: Actor; by: string; patch: UpdateTaskPatch; projectId?: string; agentTopicId?: string | null }): Task;
  /**
   * `questionOptions` turns the comment into a human-decision request: the
   * SERVER composes the canonical ```question``` block (question = content,
   * one `- option` per entry) so the board's quick-reply parser always gets a
   * well-formed block — an LLM caller passes structured options and never
   * reproduces markdown syntax by hand.
   */
  addComment(args: { taskId: string; author: string; content: string; mentions?: string[]; media?: string[]; projectId?: string; questionOptions?: string[] }): TaskComment;
  /** Human-only review decision on a task sitting in `review`. */
  reviewDecision(args: { taskId: string; by: string; decision: "approve" | "reject"; comment?: string; projectId?: string }): Task;
  /** Soft-delete (archive) — the row stays for history but drops off the board. */
  archive(args: { taskId: string; projectId?: string }): Task;
  /**
   * Nearest self-or-ancestor bound to an agent topic — the dispatch root of the
   * subtree. Lets the route answer "which agent owns this step?" when a human
   * replies on a subtask's own thread.
   */
  boundRootOf(taskId: string): Task | null;
  /**
   * Move a ROOT task (and its whole subtree) to another board. Subtasks never
   * move alone (same-board parent invariant) and a task with a live agent
   * stays put (its worktree/topic belong to the source project).
   */
  moveToProject(args: { taskId: string; toProjectId: string; projectId?: string }): Task;
  /**
   * Atomically claim a `todo` task for dispatch: move it to `in_progress` and
   * bump the attempt counter — but only if a slot is free (running < cap), it's
   * still `todo`, unclaimed, and under the retry cap. Returns the claimed Task,
   * or null if the claim didn't apply (no slot / lost the race / attempts
   * exhausted). The status CAS (`todo → in_progress`) IS the claim token; the
   * topic binding arrives later via bindTopic() once the real topic exists —
   * `assigned_topic_id` has a FK to topics(id) (migration 026), so a
   * placeholder id can never be written there.
   */
  claim(args: { taskId: string; cap: number; maxAttempts: number; agentId?: string | null }): Task | null;
  /** Release a claimed task: clear the topic binding and requeue (`todo`) or park (`backlog`), with a note. */
  release(args: { taskId: string; requeue: boolean; reason?: string; by?: string }): Task;
  /** Overwrite the topic binding of a claimed task (dispatcher: placeholder → real topic). */
  bindTopic(args: { taskId: string; topicId: string }): Task;
  /** Update just the dispatch state/error (queued|starting|working|needs_input). */
  setDispatchState(args: { taskId: string; state: string | null; error?: string | null }): Task;
  /** Accumulate agent effort on the task (dispatcher, at each turn end). */
  recordAgentUsage(args: { taskId: string; addMs: number; addTokens: number }): Task;
  /** Read the per-board dispatch config (defaults when no row exists). */
  getBoardSettings(projectId: string): BoardSettings;
  /** Upsert the per-board dispatch config. `autoDispatch` routes to the global switch. */
  updateBoardSettings(projectId: string, patch: UpdateBoardSettingsPatch): BoardSettings;
  /** Read the GLOBAL auto-dispatch switch (one for every board). */
  getGlobalAutoDispatch(): boolean;
  /** Flip the GLOBAL auto-dispatch switch; returns the new value. */
  setGlobalAutoDispatch(on: boolean): boolean;
}

/** Reserved board_settings row that carries the global auto-dispatch switch. */
const GLOBAL_SETTINGS_KEY = "*";

export function createTaskService(db: Database, opts: ServiceOpts = {}): TaskService {
  const now = opts.now ?? (() => new Date().toISOString());
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const commentDedupeMs = opts.commentDedupeMs ?? 10_000;

  // The global start switch (row '*'). Closure helper — never `this` — so the
  // methods survive being destructured off the service.
  const readGlobalDispatch = (): boolean => {
    const r = db.prepare("SELECT auto_dispatch FROM board_settings WHERE project_id = ?").get(GLOBAL_SETTINGS_KEY) as any;
    return r ? !!r.auto_dispatch : false;
  };

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
      dispatchState: r.dispatch_state ?? null,
      dispatchAttempts: r.dispatch_attempts ?? 0,
      dispatchError: r.dispatch_error ?? null,
      parentTaskId: r.parent_task_id ?? null,
      outputUrl: r.output_url ?? null,
      planFirst: !!r.plan_first,
      inProgressAt: r.in_progress_at ?? null,
      agentMs: r.agent_ms ?? 0,
      agentTokens: r.agent_tokens ?? 0,
      subtaskCount: 0,
      subtaskDoneCount: 0,
    };
  }

  /** Fill direct-children counters onto already-built tasks (board badges). */
  function withSubtaskCounts(tasks: Task[]): Task[] {
    if (tasks.length === 0) return tasks;
    const byParent = new Map<string, { total: number; done: number }>();
    const rows = db.prepare(
      `SELECT parent_task_id AS pid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks WHERE parent_task_id IS NOT NULL AND archived = 0
        GROUP BY parent_task_id`,
    ).all() as Array<{ pid: string; total: number; done: number }>;
    for (const r of rows) byParent.set(r.pid, { total: r.total, done: r.done ?? 0 });
    for (const t of tasks) {
      const c = byParent.get(t.id);
      if (c) { t.subtaskCount = c.total; t.subtaskDoneCount = c.done; }
    }
    return tasks;
  }

  /** Direct children of a task (drawer subtask list), board order. */
  function childrenOf(taskId: string): Task[] {
    const rows = db.prepare(
      "SELECT * FROM tasks WHERE parent_task_id = ? AND archived = 0 ORDER BY kanban_order ASC",
    ).all(taskId) as any[];
    return withSubtaskCounts(rows.map(rowToTask));
  }

  /**
   * True when `taskId` is a STRICT descendant of a task whose dispatch topic is
   * `topicId` — i.e. one of the calling agent's own checklist steps. Strict:
   * the assigned task itself never matches, so the agent still cannot close
   * its own deliverable (that stays behind the human review gate).
   */
  function isOwnStep(taskId: string, topicId: string): boolean {
    const r = db.prepare(
      `WITH RECURSIVE anc(id, parent, topic) AS (
         SELECT id, parent_task_id, assigned_topic_id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id, t.parent_task_id, t.assigned_topic_id
           FROM tasks t JOIN anc a ON t.id = a.parent
       )
       SELECT COUNT(*) AS c FROM anc WHERE topic = ? AND id != ?`,
    ).get(taskId, topicId, taskId) as any;
    return (r?.c ?? 0) > 0;
  }

  /** True when the task has non-done, non-archived direct children. */
  function hasActiveChildren(taskId: string): boolean {
    const r = db.prepare(
      "SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'",
    ).get(taskId) as any;
    return (r?.c ?? 0) > 0;
  }

  function rowToComment(r: any): TaskComment {
    let mentions: string[] = [];
    if (r.mentions) { try { mentions = JSON.parse(r.mentions); } catch { mentions = []; } }
    let media: string[] = [];
    if (r.media) { try { media = JSON.parse(r.media); } catch { media = []; } }
    return { id: r.id, taskId: r.task_id, author: r.author, content: r.content, mentions, media, createdAt: r.created_at, kind: r.kind === "status" ? "status" : "comment" };
  }

  /**
   * Append a status-transition event to the thread (kind='status'). Direct
   * INSERT — no dedupe, no question composing: transitions are deliberate
   * writes and each one IS the history entry ("chi l'ha spostato e quando").
   * The task's own status write already bumped updated_at (change signal).
   */
  function logStatus(taskId: string, from: string, to: string, by: string): void {
    try {
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?, ?, ?, ?, 'status', ?)",
      ).run(uuid(), taskId, by || "system", `${from}→${to}`, now());
    } catch { /* history is best-effort — never fail the transition itself */ }
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

      // Nesting: the parent must exist on the SAME board and be alive. Same
      // not_found shape as the projectId guard elsewhere (no cross-board probing).
      if (input.parentTaskId) {
        const parent = getTaskRow(input.parentTaskId);
        if (!parent || parent.project_id !== input.projectId || parent.archived) {
          throw new TaskServiceError("not_found", `parent task ${input.parentTaskId} not found`);
        }
      }

      const id = uuid();
      const ts = now();
      const priority = input.priority ?? 2;
      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(input.projectId) as any;
      const order = (maxRow?.m ?? 0) + 1;

      db.prepare(
        `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, chat_id, created_at, completed_at, updated_at, claude_task_id, parent_task_id, plan_first)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(
        id, input.projectId, text, input.description ?? null, status, priority, order,
        input.assignedTo ?? null, input.chatId ?? null, ts, ts, input.idempotencyKey ?? null,
        input.parentTaskId ?? null, input.planFirst ? 1 : 0,
      );
      return rowToTask(getTaskRow(id));
    },

    get(taskId, opts) {
      const row = getTaskRow(taskId);
      if (!row) return null;
      if (opts?.projectId && row.project_id !== opts.projectId) return null;
      const comments = db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[];
      const [task] = withSubtaskCounts([rowToTask(row)]);
      return { task, comments: comments.map(rowToComment), children: childrenOf(taskId) };
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
      if (input.rootsOnly) clauses.push("parent_task_id IS NULL");
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      // project scope → board order (status then kanban_order); global feed → recency.
      const order = input.scope === "all" ? "updated_at DESC" : "kanban_order ASC";
      const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY ${order}`).all(...params) as any[];
      return withSubtaskCounts(rows.map(rowToTask));
    },

    update({ taskId, actor, by, patch, projectId, agentTopicId }): Task {
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
        // ONE carve-out: its own checklist steps (strict descendants of the
        // task bound to its topic) close directly — they are the agent's plan,
        // not the deliverable the human reviews.
        if (patch.status === "done" && actor === "agent" && !(agentTopicId && isOwnStep(taskId, agentTopicId))) {
          throw new TaskServiceError(
            "agent_cannot_complete",
            "agents deliver to 'review' for human approval; only a human moves 'review' → 'done' (exception: subtask steps of YOUR assigned task). Set status to 'review' instead.",
          );
        }
        // A parent is not done while its subtasks are open — for ANY actor.
        // Complete or archive the children first (structural invariant, not a
        // board setting).
        if (patch.status === "done" && hasActiveChildren(taskId)) {
          throw new TaskServiceError(
            "open_subtasks",
            "task has open subtasks — complete or archive them before marking it done",
          );
        }
        // Agent entering review → open a pending review approval for the human.
        if (patch.status === "review" && actor === "agent" && current !== "review") {
          // A delivery must never be mute: the review card surfaces the agent's
          // last word (KANBAN-04 "mai alla cieca"), so a thread with zero agent
          // comments would leave the human staring at bare Approva/Rifiuta.
          // Coach a retry instead — same pattern as comment_too_long.
          // kind='comment' only: a status event authored by the agent (its own
          // step flips) must not satisfy the "say something" gate.
          const own = (db.prepare(
            "SELECT COUNT(*) AS c FROM task_comments WHERE task_id = ? AND author NOT IN ('user', 'system') AND kind = 'comment'",
          ).get(taskId) as any).c as number;
          if (own === 0) {
            throw new TaskServiceError(
              "review_needs_summary",
              "post a short delivery summary first — comment_task with 1-2 sentences (what was done, where to look) — THEN set status='review'",
            );
          }
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
      if (patch.outputUrl !== undefined) {
        const url = (patch.outputUrl ?? "").trim();
        // http(s) only: the review panel renders this in an iframe — never
        // file:// (LFI) or javascript: (XSS). Empty clears.
        if (url && !/^https?:\/\//i.test(url)) {
          throw new TaskServiceError("invalid_input", "output_url must be an http(s) URL");
        }
        put("output_url", url || null);
      }
      if (patch.status !== undefined) {
        put("status", patch.status);
        put("completed_at", patch.status === "done" ? now() : null);
        // A card leaving the flow keeps no live chip: dragging review → done
        // used to strand "delivered"/"serve te" on a closed card (only
        // reviewDecision cleared it).
        if (patch.status === "done") put("dispatch_state", null);
      }
      put("updated_at", now());

      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, taskId);
      // Status history: every applied transition lands in the thread with its
      // author — the timeline answers "chi l'ha spostato e quando".
      if (patch.status !== undefined && patch.status !== current) logStatus(taskId, current, patch.status, by);
      return rowToTask(getTaskRow(taskId));
    },

    addComment({ taskId, author, content, mentions, media, projectId, questionOptions }): TaskComment {
      let body = (content ?? "").trim();
      // Attachments-only comments are legal (a screenshot IS the message).
      if (!body && (!media || media.length === 0)) throw new TaskServiceError("invalid_input", "comment content is required");
      if (!body) body = "(allegato)";
      // Absolute paths only (the /api/upload contract); cap the count.
      const files = (media ?? []).filter((p) => typeof p === "string" && p.startsWith("/")).slice(0, 8);
      // Canonical question block, composed HERE (single writer) — the caller
      // passes the question as plain content + structured options; the exact
      // fence/newline layout the quick-reply parser expects is never delegated
      // to an LLM. A question inside `content` that already carries fences
      // would nest ambiguously → reject as invalid input.
      if (questionOptions && questionOptions.length > 0) {
        const options = questionOptions.map((o) => String(o ?? "").trim()).filter(Boolean);
        if (options.length === 0) throw new TaskServiceError("invalid_input", "question options are empty");
        if (body.includes("```")) throw new TaskServiceError("invalid_input", "question content must not contain code fences");
        body = ["```question", body.replace(/\r?\n/g, " ").trim(), ...options.map((o) => `- ${o}`), "```"].join("\n");
      }
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
        "INSERT INTO task_comments (id, task_id, author, content, mentions, media, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, taskId, author, body, mentions && mentions.length ? JSON.stringify(mentions) : null, files.length ? JSON.stringify(files) : null, ts);
      // The thread is part of the task: touch updated_at so live clients (open
      // drawer, review card) see a change signal and refetch — without this, a
      // new comment broadcasts task:updated but the payload looks identical.
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, taskId);
      return rowToComment(db.prepare("SELECT * FROM task_comments WHERE id = ?").get(id));
    },

    reviewDecision({ taskId, by, decision, comment, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      if (row.status !== "review") throw new TaskServiceError("invalid_transition", "task is not in review");
      // Same structural invariant as update(): approving must not close a
      // parent whose subtasks are still open.
      if (decision === "approve" && hasActiveChildren(taskId)) {
        throw new TaskServiceError(
          "open_subtasks",
          "task has open subtasks — complete or archive them before approving it to done",
        );
      }
      const ts = now();

      // Resolve the pending review approval, if any.
      db.prepare(
        "UPDATE approvals SET status = ?, reviewed_by = ?, review_comment = ?, reviewed_at = ? WHERE task_id = ? AND approval_type = 'review' AND status = 'pending'",
      ).run(decision === "approve" ? "approved" : "rejected", by, comment ?? null, ts, taskId);

      if (comment && comment.trim()) {
        this.addComment({ taskId, author: by, content: comment });
      }

      const target: TaskStatus = decision === "approve" ? "done" : "in_progress";
      // Clear the dispatch chip on the human decision: an approved (done) card must
      // not keep a stale "working"/"serve te" chip, and a rejected one is about to
      // be re-kicked by the dispatcher (resume sets "working" itself).
      db.prepare("UPDATE tasks SET status = ?, completed_at = ?, dispatch_state = NULL, updated_at = ? WHERE id = ?")
        .run(target, target === "done" ? ts : null, ts, taskId);
      logStatus(taskId, "review", target, by);
      return rowToTask(getTaskRow(taskId));
    },

    archive({ taskId, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const ts = now();
      // Cascade: archiving a parent archives its whole subtree (soft-delete,
      // unlimited depth) — orphan subtasks of an archived parent would be
      // unreachable rows the board can never show in context.
      db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         )
         UPDATE tasks SET archived = 1, updated_at = ? WHERE id IN (SELECT id FROM subtree)`,
      ).run(taskId, ts);
      return rowToTask(getTaskRow(taskId));
    },

    boundRootOf(taskId) {
      const r = db.prepare(
        `WITH RECURSIVE chain(id, parent, topic, depth) AS (
           SELECT id, parent_task_id, assigned_topic_id, 0 FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id, t.parent_task_id, t.assigned_topic_id, c.depth + 1
             FROM tasks t JOIN chain c ON t.id = c.parent
         )
         SELECT id FROM chain WHERE topic IS NOT NULL ORDER BY depth ASC LIMIT 1`,
      ).get(taskId) as any;
      return r ? rowToTask(getTaskRow(r.id)) : null;
    },

    moveToProject({ taskId, toProjectId, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const target = (toProjectId ?? "").trim();
      if (!target) throw new TaskServiceError("invalid_input", "toProjectId is required");
      if (row.project_id === target) return rowToTask(row);
      // Only the ROOT of a subtree moves: create() pins a subtask to its
      // parent's board, so the subtree travels together or not at all.
      if (row.parent_task_id) {
        throw new TaskServiceError("invalid_transition", "task is a subtask — move its root task (the subtree moves together)");
      }
      // A dispatched agent works a worktree/topic of the SOURCE project; moving
      // the task under it would strand the binding. Finish or release it first.
      if (row.assigned_topic_id || ["queued", "starting", "working"].includes(row.dispatch_state ?? "")) {
        throw new TaskServiceError("invalid_transition", "task has a live agent — let it reach review (or park it) before moving boards");
      }
      const ts = now();
      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(target) as any;
      db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         )
         UPDATE tasks SET project_id = ?, updated_at = ? WHERE id IN (SELECT id FROM subtree)`,
      ).run(taskId, target, ts);
      // Re-append the root at the end of the target board; children keep their
      // relative order (kanban_order is just a per-board sort key).
      db.prepare("UPDATE tasks SET kanban_order = ? WHERE id = ?").run((maxRow?.m ?? 0) + 1, taskId);
      return rowToTask(getTaskRow(taskId));
    },

    claim({ taskId, cap, maxAttempts, agentId }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // Concurrency cap: count tasks already claimed by a dispatch (in_progress
      // with a live dispatch chip) on this board. The task itself is still
      // `todo` here, so it is not in the count. bun:sqlite is synchronous +
      // single-process, so this read-then-CAS is atomic w.r.t. other claims.
      const running = (db.prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'in_progress' AND dispatch_state IN ('starting','working') AND archived = 0",
      ).get(row.project_id) as any).c as number;
      if (running >= cap) return null;
      const ts = now();
      const res = db.prepare(
        `UPDATE tasks
            SET assigned_agent_id = ?, status = 'in_progress',
                in_progress_at = ?, dispatch_state = 'starting',
                dispatch_attempts = dispatch_attempts + 1, dispatch_error = NULL, updated_at = ?
          WHERE id = ? AND status = 'todo' AND assigned_topic_id IS NULL AND dispatch_attempts < ?`,
      ).run(agentId ?? null, ts, ts, taskId, maxAttempts);
      if (res.changes !== 1) return null; // lost the race / not todo / attempts exhausted
      logStatus(taskId, "todo", "in_progress", "dispatcher");
      return rowToTask(getTaskRow(taskId));
    },

    release({ taskId, requeue, reason, by }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // Note first (so the "worked in topic X" trail survives clearing the link).
      if (reason && reason.trim()) {
        try { this.addComment({ taskId, author: by ?? "system", content: reason }); } catch { /* dedupe/best-effort */ }
      }
      const ts = now();
      const status: TaskStatus = requeue ? "todo" : "backlog";
      const state = requeue ? "queued" : null;
      db.prepare(
        `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL,
            status = ?, dispatch_state = ?, dispatch_error = ?, updated_at = ? WHERE id = ?`,
      ).run(status, state, reason ?? null, ts, taskId);
      if (row.status !== status) logStatus(taskId, row.status, status, by ?? "dispatcher");
      return rowToTask(getTaskRow(taskId));
    },

    bindTopic({ taskId, topicId }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET assigned_topic_id = ?, chat_id = ?, updated_at = ? WHERE id = ?")
        .run(topicId, topicId, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    recordAgentUsage({ taskId, addMs, addTokens }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const ms = Math.max(0, Math.trunc(addMs || 0));
      const tok = Math.max(0, Math.trunc(addTokens || 0));
      db.prepare(
        "UPDATE tasks SET agent_ms = agent_ms + ?, agent_tokens = agent_tokens + ?, updated_at = ? WHERE id = ?",
      ).run(ms, tok, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    setDispatchState({ taskId, state, error }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET dispatch_state = ?, dispatch_error = ?, updated_at = ? WHERE id = ?")
        .run(state, error ?? null, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    getGlobalAutoDispatch(): boolean {
      return readGlobalDispatch();
    },

    setGlobalAutoDispatch(on: boolean): boolean {
      db.prepare(
        "INSERT INTO board_settings (project_id, auto_dispatch, max_agents) VALUES (?, ?, 2) " +
        "ON CONFLICT(project_id) DO UPDATE SET auto_dispatch = excluded.auto_dispatch",
      ).run(GLOBAL_SETTINGS_KEY, on ? 1 : 0);
      return readGlobalDispatch();
    },

    getBoardSettings(projectId: string): BoardSettings {
      const r = db.prepare("SELECT * FROM board_settings WHERE project_id = ?").get(projectId) as any;
      return {
        projectId,
        autoDispatch: readGlobalDispatch(),
        maxAgents: r ? (r.max_agents ?? 2) : 2,
        dispatchEffort: r?.dispatch_effort ?? "medium",
        dispatchUseWorktree: r ? !!r.dispatch_use_worktree : true,
        dispatchTimeoutMin: r?.dispatch_timeout_min ?? 20,
        requireApprovalForDone: r ? !!r.require_approval_for_done : false,
        requireReviewBeforeDone: r ? !!r.require_review_before_done : false,
      };
    },

    updateBoardSettings(projectId: string, patch: UpdateBoardSettingsPatch): BoardSettings {
      if (!projectId) throw new TaskServiceError("invalid_input", "projectId is required");
      if (patch.dispatchEffort !== undefined && !VALID_EFFORT.has(patch.dispatchEffort)) {
        throw new TaskServiceError("invalid_input", `invalid effort "${patch.dispatchEffort}"`);
      }
      // Ensure a row exists. Seed max_agents at the dispatch default (2), NOT the
      // legacy board_settings column default (5) — otherwise merely toggling
      // auto_dispatch would materialise the row at cap 5 and silently over-run the
      // "2" shown in the panel. INSERT OR IGNORE only sets it on first creation.
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 2)").run(projectId);
      // autoDispatch is the GLOBAL switch: route it to the '*' row so flipping
      // it from any board (or the global board) flips it everywhere.
      if (patch.autoDispatch !== undefined) {
        db.prepare(
          "INSERT INTO board_settings (project_id, auto_dispatch, max_agents) VALUES (?, ?, 2) " +
          "ON CONFLICT(project_id) DO UPDATE SET auto_dispatch = excluded.auto_dispatch",
        ).run(GLOBAL_SETTINGS_KEY, patch.autoDispatch ? 1 : 0);
      }
      const sets: string[] = [];
      const params: any[] = [];
      if (patch.maxAgents !== undefined) { sets.push("max_agents = ?"); params.push(clampInt(patch.maxAgents, 1, 10)); }
      if (patch.dispatchEffort !== undefined) { sets.push("dispatch_effort = ?"); params.push(patch.dispatchEffort); }
      if (patch.dispatchUseWorktree !== undefined) { sets.push("dispatch_use_worktree = ?"); params.push(patch.dispatchUseWorktree ? 1 : 0); }
      if (patch.dispatchTimeoutMin !== undefined) { sets.push("dispatch_timeout_min = ?"); params.push(clampInt(patch.dispatchTimeoutMin, 1, 120)); }
      if (sets.length) db.prepare(`UPDATE board_settings SET ${sets.join(", ")} WHERE project_id = ?`).run(...params, projectId);
      return this.getBoardSettings(projectId);
    },
  };
}

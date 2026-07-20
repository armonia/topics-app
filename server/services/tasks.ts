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
import { existsSync } from "node:fs";

export type TaskStatus = "backlog" | "todo" | "in_progress" | "review" | "done";
export type Actor = "human" | "agent";

const STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "review", "done"];

/**
 * Reserved board id for tasks created WITHOUT a project (e.g. work spanning
 * several projects). They live on the global board only; the dispatcher skips
 * them entirely (an agent needs a cwd) until a human assigns a real board via
 * move — never a park-bounce to backlog.
 */
export const UNASSIGNED_PROJECT_ID = "_none";

/**
 * Virtual board id the composer posts to when the project is on "Auto": the
 * create route resolves the REAL board from the task text (a known project
 * name mentioned in title/description). Never stored on a task — unresolved
 * creates land on UNASSIGNED_PROJECT_ID.
 */
export const AUTO_PROJECT_ID = "_auto";

/**
 * Reserved quick-reply label the AGENT is prompted to offer at delivery when its
 * work is landable. The board route matches a human's pick of exactly this option
 * and runs the land (approve + merge to main) instead of resuming the agent —
 * that's how "the agent proposes the next step, the human decides, the system
 * executes" works without the merge riding on every approve. Keep in sync with
 * the prompt in task-dispatcher.ts (both import this constant).
 */
export const LAND_ACTION_LABEL = "Landa su main";
/**
 * Reserved option for "go online": land (merge to main) AND publish (push →
 * deploy CI). The agent may offer it at delivery too; picking it runs the whole
 * chain server-side. "Andare online" stays a human pick — the agent never pushes.
 */
export const PUBLISH_ACTION_LABEL = "Landa e pubblica";
const normLabel = (s: string) => s.replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
/** Tolerant match (ignores emoji/punctuation/spacing the model may add). */
export function isLandActionLabel(text: string | undefined | null): boolean {
  return !!text && normLabel(text) === normLabel(LAND_ACTION_LABEL);
}
export function isPublishActionLabel(text: string | undefined | null): boolean {
  return !!text && normLabel(text) === normLabel(PUBLISH_ACTION_LABEL);
}

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
  /** Screenshot della consegna (path assoluto allowlistato, servito da
   *  /api/media) — thumbnail sulla card Kanban. */
  previewImage: string | null;
  /** Dispatch contract: deliver a PLAN to review before implementing. */
  planFirst: boolean;
  /** When the current claim started (dispatcher CAS) — the live "ci sta
   *  mettendo" ticker anchors here while a turn runs. */
  inProgressAt: string | null;
  /** Cumulative agent effort: wall-clock ms + tokens across every turn.
   *  agentTokens = input+output+cacheWrite (dedup); cache READS ride separately
   *  — they dominate real consumption but aren't "work" tokens. */
  agentMs: number;
  agentTokens: number;
  agentCacheReadTokens: number;
  /** Nobody chose a priority: the dispatched agent evaluates and sets one. */
  priorityAuto: boolean;
  /** Model override for the agent topic. null = auto (provider default). */
  model: string | null;
  /** Dependency: not dispatch-eligible until this task is done/archived. */
  blockedByTaskId: string | null;
  /** Dispatch in the BLOCKER agent's conversation instead of a fresh topic. */
  reuseBlockerContext: boolean;
  /** Direct-children counters (filled by list/get for board badges). */
  subtaskCount: number;
  subtaskDoneCount: number;
  /** Human interactions in the thread: comments authored by 'user' (kind
   *  'comment') — excludes the AI/agent, system notes and status events. Filled
   *  by list/get; the card shows it as a "quanti messaggi ho mandato" count. */
  userCommentCount: number;
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
  /** Model override for the agent topic. Omit/null = auto. */
  model?: string | null;
  /** Wait for this task before dispatching (exists, not self, no cycle). */
  blockedByTaskId?: string | null;
  /** Reuse the blocker agent's conversation at dispatch. */
  reuseBlockerContext?: boolean;
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
  /** Screenshot per la card (path assoluto); empty string / null clears it.
   *  Il gate sull'allowlist media sta nel layer route (come i media commenti). */
  previewImage?: string | null;
  /** Model override for the agent topic; null clears (= auto). */
  model?: string | null;
  /** Dependency; null clears. Validated: exists, not self, no cycle. */
  blockedByTaskId?: string | null;
  reuseBlockerContext?: boolean;
  /** Toggle "plan first" after creation (agent delivers a plan to approve before implementing). */
  planFirst?: boolean;
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
  /** When true, the cap is auto-sized from live machine capacity (dispatch-capacity.ts)
   *  and `maxAgents` is ignored for dispatch (kept as the manual fallback value). */
  maxAgentsAuto: boolean;
  dispatchEffort: string;
  dispatchUseWorktree: boolean;
  /**
   * Auto-merge the task's worktree branch into the project's main checkout when a
   * human approves it (review → done). Programmatic: clean merge lands locally (NO
   * push); a conflict hands the branch back to the task's own agent to resolve; an
   * unready checkout (dirty / not on main) is skipped. Default OFF — no existing
   * board changes behaviour until it's turned on. Only meaningful with
   * `dispatchUseWorktree` on (an in-place task has no branch to merge).
   */
  dispatchAutoMerge: boolean;
  dispatchTimeoutMin: number;
  /**
   * MCP fleet for dispatched agents on this board (migration 049).
   * 'bridge-only' (the NULL default) = only the topics bridge, dispatch tool
   * profile — the global fleet's tool schemas never enter the agent's context.
   * 'inherit' = escape hatch: the session inherits the user's full MCP fleet
   * (for boards whose tasks genuinely need those tools).
   */
  dispatchMcp: string;
  /**
   * Default model for dispatched agents on this board.
   * 'auto' (the NULL default) → the classifier picks a model per task (prior
   * behaviour). A concrete model id (e.g. 'claude-opus-4-8') pins every dispatch
   * on this board to it. An explicit per-task model still wins over the board default.
   */
  dispatchModel: string;
  /** Launch attempts before a task is parked (default 2). */
  dispatchRetryCap: number;
  /** Backoff (s) before resuming a turn that died faster than it (outage guard, default 60). */
  dispatchRetryBackoffS: number;
  requireApprovalForDone: boolean;
  requireReviewBeforeDone: boolean;
}

export interface UpdateBoardSettingsPatch {
  autoDispatch?: boolean;
  maxAgents?: number;
  maxAgentsAuto?: boolean;
  dispatchEffort?: string;
  dispatchUseWorktree?: boolean;
  dispatchAutoMerge?: boolean;
  dispatchTimeoutMin?: number;
  dispatchMcp?: string;
  dispatchModel?: string;
  dispatchRetryCap?: number;
  dispatchRetryBackoffS?: number;
}

const VALID_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_DISPATCH_MCP = new Set(["bridge-only", "inherit"]);
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
  /** Injectable for tests: whether a media path exists on disk (default node:fs existsSync). */
  fileExists?: (p: string) => boolean;
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
  /**
   * System hand-off to review after the dispatch retry budget is exhausted: the
   * agent WORKED (left a comment trail) but never moved the task to `review`
   * itself. Instead of parking it as `failed` (opaque, looks like an error), we
   * deliver it to the human — status `review`, chip `needs_input`, a `system`
   * note explaining what happened — keeping the topic binding so a rejection
   * resumes the same agent. Opens the pending review approval like a normal
   * hand-off. Reserved for the "did work, forgot to deliver" case; a task that
   * produced nothing still parks as `failed`.
   */
  deliverToReviewBySystem(args: { taskId: string; reason: string }): Task;
  /** Soft-delete (archive) — the row stays for history but drops off the board. */
  archive(args: { taskId: string; projectId?: string }): Task;
  /**
   * Nearest self-or-ancestor bound to an agent topic — the dispatch root of the
   * subtree. Lets the route answer "which agent owns this step?" when a human
   * replies on a subtask's own thread.
   */
  boundRootOf(taskId: string): Task | null;
  /**
   * The board project of the task dispatched to `topicId` (its `assigned_topic_id`).
   * This is the AUTHORITATIVE board for a dispatched agent's session — unlike the
   * topic's cwd, which for a catch-all task is a per-task private dir that maps to
   * no real board. Session task routes use this so the agent can find/comment its
   * own task even on the "generale" catch-all board. Null when the topic has no
   * bound task (a normal chat topic, not a dispatch session).
   */
  boardProjectForTopic(topicId: string): string | null;
  /**
   * The task dispatched to `topicId` (its `assigned_topic_id`) — the whole
   * handle the task-owned browser fork needs: id (→ the canonical
   * `task-<id8>-…` browser contextId), project, and text (→ the tab-inventory
   * label). Same resolution as boardProjectForTopic (prefer non-archived, most
   * recent). Null when the topic owns no task (a normal chat, not a dispatch).
   */
  taskForTopic(topicId: string): { id: string; projectId: string; text: string } | null;
  /**
   * Resolve a task from the 8-char id prefix embedded in a `task-<id8>-…`
   * browser contextId → { id, text }, so the tab inventory can label it
   * "Task: <text>". Prefers a non-archived, most-recent row if a prefix ever
   * collides (astronomically unlikely on 32 bits). Null when none matches.
   */
  taskByIdPrefix(id8: string): { id: string; text: string } | null;
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
  claim(args: { taskId: string; cap: number; maxAttempts: number; agentId?: string | null; scope?: "board" | "global" }): Task | null;
  /**
   * Bump the attempt counter of a LIVE claim (in_progress + bound topic) —
   * the dispatcher's resume-continuation after a timed-out turn. Returns the
   * updated Task, or null when the cap is hit or the claim is gone (caller
   * parks / drops).
   */
  bumpDispatchAttempt(args: { taskId: string; maxAttempts: number }): Task | null;
  /** Alive tasks whose blocked-by points at `taskId` (unblock fan-out when it completes). */
  listBlockedBy(taskId: string): Task[];
  /**
   * True when the task's blocker is still open — the SAME predicate the claim
   * CAS enforces (blocker not done and not archived), so the dispatcher's
   * eligibility filter can never diverge from the claim.
   */
  isDispatchBlocked(taskId: string): boolean;
  /**
   * Release a claimed task: clear the topic binding and requeue (`todo`) or park
   * (`backlog`), with a note.
   * - `parkState`: the dispatch_state to stamp on a PARK (requeue:false) — e.g.
   *   'failed' (genuine agent failure) vs 'blocked' (config the human must fix).
   *   Ignored on a requeue (which always shows 'queued'). Default null.
   * - `rollbackAttempt`: decrement dispatch_attempts by 1 (floored at 0). Used by
   *   the restart-orphan requeue so a server restart never erodes the retry budget.
   */
  release(args: { taskId: string; requeue: boolean; reason?: string; by?: string; parkState?: string | null; rollbackAttempt?: boolean }): Task;
  /** Overwrite the topic binding of a claimed task (dispatcher: placeholder → real topic). */
  bindTopic(args: { taskId: string; topicId: string }): Task;
  /** Update just the dispatch state/error (queued|starting|working|needs_input). */
  setDispatchState(args: { taskId: string; state: string | null; error?: string | null }): Task;
  /** Persist the model actually resolved for a run (auto-pick → concrete id) so
   *  the card stops showing "auto" once the agent has run. */
  setModel(args: { taskId: string; model: string | null }): Task;
  /** Accumulate agent effort on the task (dispatcher, at each turn end). */
  recordAgentUsage(args: { taskId: string; addMs: number; addTokens: number; addCacheReadTokens?: number }): Task;
  /** Read the per-board dispatch config (defaults when no row exists). */
  getBoardSettings(projectId: string): BoardSettings;
  /** Upsert the per-board dispatch config. `autoDispatch` routes to the global switch. */
  updateBoardSettings(projectId: string, patch: UpdateBoardSettingsPatch): BoardSettings;
  /** Read the GLOBAL auto-dispatch switch (one for every board). */
  getGlobalAutoDispatch(): boolean;
  /** Flip the GLOBAL auto-dispatch switch; returns the new value. */
  setGlobalAutoDispatch(on: boolean): boolean;
  /** Read the GLOBAL concurrency cap (reserved row '*'): the ONE machine-wide
   *  budget the dispatcher enforces across ALL boards. `auto` → size it from live
   *  machine capacity; otherwise use the fixed `max`. Auto is the default until a
   *  manual number is explicitly chosen, so the machine is protected out of the box. */
  getGlobalCap(): { auto: boolean; max: number };
  /** Update the GLOBAL cap (row '*': max_agents_auto / max_agents). */
  setGlobalCap(patch: { auto?: boolean; max?: number }): { auto: boolean; max: number };
}

/** Reserved board_settings row that carries the global auto-dispatch switch. */
const GLOBAL_SETTINGS_KEY = "*";

export function createTaskService(db: Database, opts: ServiceOpts = {}): TaskService {
  const now = opts.now ?? (() => new Date().toISOString());
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const commentDedupeMs = opts.commentDedupeMs ?? 10_000;
  const fileExists = opts.fileExists ?? existsSync;

  // ── Review-evidence promotion ──
  // The delivery protocol asks agents for update_task(previewImage=…), but in
  // practice they attach the evidence to the delivery COMMENT and the board
  // card stays blind (3 out of 3 first real dispatches). Same philosophy as
  // the dispatcher's mirrored delivery comment: the server GUARANTEES the
  // outcome instead of relying on agent discipline. When a task is in review
  // with no preview, promote the newest previewable comment attachment
  // (image/video, absolute path, existing on disk) to `preview_image`.
  // Idempotent and best-effort: an explicit previewImage always wins (we only
  // fill the empty case), and any failure just leaves the card without
  // preview — exactly the status quo.
  const PREVIEWABLE_MEDIA = /\.(png|jpe?g|gif|webp|webm|mp4|mov)$/i;
  function promoteReviewPreview(taskId: string): void {
    try {
      const row = getTaskRow(taskId);
      if (!row || row.status !== "review" || (row.preview_image ?? "").trim()) return;
      const rows = db.prepare(
        "SELECT media FROM task_comments WHERE task_id = ? AND media IS NOT NULL ORDER BY created_at DESC LIMIT 10",
      ).all(taskId) as Array<{ media: string }>;
      for (const r of rows) {
        let files: unknown;
        try { files = JSON.parse(r.media); } catch { continue; }
        if (!Array.isArray(files)) continue;
        for (const f of files) {
          if (typeof f !== "string" || !f.startsWith("/") || !PREVIEWABLE_MEDIA.test(f)) continue;
          if (!fileExists(f)) continue;
          db.prepare("UPDATE tasks SET preview_image = ?, updated_at = ? WHERE id = ?").run(f, now(), taskId);
          return;
        }
      }
    } catch { /* best-effort — the card just stays without a preview */ }
  }

  // The global start switch (row '*'). Closure helper — never `this` — so the
  // methods survive being destructured off the service.
  const readGlobalDispatch = (): boolean => {
    const r = db.prepare("SELECT auto_dispatch FROM board_settings WHERE project_id = ?").get(GLOBAL_SETTINGS_KEY) as any;
    return r ? !!r.auto_dispatch : false;
  };

  // The model shown on a task must ALWAYS reflect what actually ran: task.model
  // may be null ("auto") even after dispatch, but the agent's TOPIC was created
  // with the resolved model — so fall back to it. try/catch guards test contexts
  // whose stub `topics` table has no `model` column.
  function resolveModel(r: any): string | null {
    if (r.model) return r.model;
    if (r.assigned_topic_id) {
      try {
        const t = db.prepare("SELECT model FROM topics WHERE id = ?").get(r.assigned_topic_id) as { model?: string | null } | undefined;
        if (t?.model) return t.model;
      } catch { /* topics stub without a model column (tests) */ }
    }
    return null;
  }

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
      previewImage: r.preview_image ?? null,
      planFirst: !!r.plan_first,
      inProgressAt: r.in_progress_at ?? null,
      agentMs: r.agent_ms ?? 0,
      agentTokens: r.agent_tokens ?? 0,
      agentCacheReadTokens: r.agent_cache_read_tokens ?? 0,
      priorityAuto: r.priority_auto == null ? true : !!r.priority_auto,
      model: resolveModel(r),
      blockedByTaskId: r.blocked_by_task_id ?? null,
      reuseBlockerContext: !!r.reuse_blocker_context,
      subtaskCount: 0,
      subtaskDoneCount: 0,
      userCommentCount: 0,
    };
  }

  /** Fill board-badge counters onto already-built tasks: direct-children
   *  progress AND the human interaction count (user 'comment' messages). */
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
    // Human message count per task: comments the user sent (kind='comment'),
    // excluding the AI/agent, system notes and auto status events.
    const byTask = new Map<string, number>();
    const mrows = db.prepare(
      `SELECT task_id AS tid, COUNT(*) AS n
         FROM task_comments
        WHERE author = 'user' AND kind = 'comment'
        GROUP BY task_id`,
    ).all() as Array<{ tid: string; n: number }>;
    for (const r of mrows) byTask.set(r.tid, r.n);
    for (const t of tasks) {
      const c = byParent.get(t.id);
      if (c) { t.subtaskCount = c.total; t.subtaskDoneCount = c.done; }
      t.userCommentCount = byTask.get(t.id) ?? 0;
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

  /**
   * Validate a blocked-by edge `taskId → blockerId`. The blocker must exist
   * and be alive; self-blocks and cycles (walking the blockers' own chain)
   * are rejected — a cycle would deadlock the whole dispatch queue.
   */
  function assertBlockerValid(taskId: string, blockerId: string): void {
    const blocker = getTaskRow(blockerId);
    if (!blocker || blocker.archived) {
      throw new TaskServiceError("not_found", `blocker task ${blockerId} not found`);
    }
    if (blockerId === taskId) {
      throw new TaskServiceError("invalid_input", "a task cannot be blocked by itself");
    }
    let cur: string | null = blocker.blocked_by_task_id ?? null;
    for (let hops = 0; cur && hops < 100; hops++) {
      if (cur === taskId) throw new TaskServiceError("invalid_input", "blocked-by chain would form a cycle");
      cur = (getTaskRow(cur)?.blocked_by_task_id ?? null) as string | null;
    }
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

      // Dependency at creation: the blocker must exist (a fresh id can never
      // be inside an existing chain, so the cycle walk is trivially safe).
      if (input.blockedByTaskId) assertBlockerValid(id, input.blockedByTaskId);

      db.prepare(
        `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, chat_id, created_at, completed_at, updated_at, claude_task_id, parent_task_id, plan_first, model, blocked_by_task_id, reuse_blocker_context, priority_auto)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.projectId, text, input.description ?? null, status, priority, order,
        input.assignedTo ?? null, input.chatId ?? null, ts, ts, input.idempotencyKey ?? null,
        input.parentTaskId ?? null, input.planFirst ? 1 : 0,
        input.model ?? null, input.blockedByTaskId ?? null, input.reuseBlockerContext ? 1 : 0,
        // "Priorità automatica": no explicit choice at creation = the
        // dispatched agent evaluates and sets one at kickoff.
        input.priority === undefined ? 1 : 0,
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
          // A delivery must never be mute — AND the summary must be about THIS
          // turn, not a stale one from an earlier exchange. Checking "any agent
          // comment ever" let a steered task ("altro da fare?" → review) hand back
          // a mute delivery: an old comment satisfied the gate while the current
          // turn said nothing. So require a comment made AFTER this turn started
          // (the newest `…→in_progress` status event). Coach a retry — same
          // pattern as comment_too_long. kind='comment' only: an agent-authored
          // status flip must not satisfy the gate.
          const turnStart = (db.prepare(
            "SELECT MAX(created_at) AS ts FROM task_comments WHERE task_id = ? AND kind = 'status' AND content LIKE '%in\\_progress' ESCAPE '\\'",
          ).get(taskId) as any).ts as string | null;
          const fresh = (db.prepare(
            `SELECT COUNT(*) AS c FROM task_comments
              WHERE task_id = ? AND author NOT IN ('user', 'system') AND kind = 'comment'
                AND (? IS NULL OR created_at >= ?)`,
          ).get(taskId, turnStart, turnStart) as any).c as number;
          if (fresh === 0) {
            throw new TaskServiceError(
              "review_needs_summary",
              "post a delivery summary for THIS turn first — comment_task with 1-2 sentences (what you did now, where to look; even \"nothing new\" with the reason) — THEN set status='review'",
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
      if (patch.priority !== undefined) {
        put("priority", patch.priority);
        // An explicit write (human OR the agent fulfilling "auto") settles it.
        put("priority_auto", 0);
      }
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
      if (patch.previewImage !== undefined) {
        const p = (patch.previewImage ?? "").trim();
        // Path assoluto su disco, mai un URL: il client lo rende via
        // /api/media (allowlist-gated). Empty clears.
        if (p && !p.startsWith("/")) {
          throw new TaskServiceError("invalid_input", "preview_image must be an absolute file path");
        }
        put("preview_image", p || null);
      }
      if (patch.model !== undefined) {
        const m = (patch.model ?? "").trim();
        put("model", m || null);
      }
      if (patch.blockedByTaskId !== undefined) {
        if (patch.blockedByTaskId) assertBlockerValid(taskId, patch.blockedByTaskId);
        put("blocked_by_task_id", patch.blockedByTaskId || null);
      }
      if (patch.reuseBlockerContext !== undefined) put("reuse_blocker_context", patch.reuseBlockerContext ? 1 : 0);
      if (patch.planFirst !== undefined) put("plan_first", patch.planFirst ? 1 : 0);
      if (patch.status !== undefined) {
        put("status", patch.status);
        put("completed_at", patch.status === "done" ? now() : null);
        // A card leaving the flow keeps no live chip: dragging review → done
        // used to strand "delivered"/"serve te" on a closed card (only
        // reviewDecision cleared it).
        if (patch.status === "done") put("dispatch_state", null);
        // A task arriving in review is a hand-off, not live work: settle a
        // lingering in-flight chip ('queued'/'starting'/'working') to
        // 'delivered' so a review card never shows the "agent al lavoro" UI
        // (which also double-renders the feedback input — steer + review). An
        // already-settled chip ('needs_input'/'delivered') is kept as-is; the
        // dispatcher's own delivery detection still refines it when it observes
        // a question (→ needs_input).
        if (patch.status === "review" && ["queued", "starting", "working"].includes(row.dispatch_state ?? "")) {
          put("dispatch_state", "delivered");
        }
        // A HUMAN dragging a task into todo is a fresh mandate: reset the
        // retry budget. Without this, a task parked at the cap could never be
        // re-dispatched — the claim filter skipped it and the card stranded
        // on "in coda" forever. Agents don't get to refresh their own retries.
        if (patch.status === "todo" && actor === "human") put("dispatch_attempts", 0);
      }
      put("updated_at", now());

      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, taskId);
      // Status history: every applied transition lands in the thread with its
      // author — the timeline answers "chi l'ha spostato e quando".
      if (patch.status !== undefined && patch.status !== current) logStatus(taskId, current, patch.status, by);
      // Hand-off into review without an explicit preview: promote the
      // delivery comment's evidence (comment-first delivery order).
      if (patch.status === "review") promoteReviewPreview(taskId);
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
      // Evidence attached AFTER the review transition (review-first delivery
      // order): fill the still-empty card preview from this attachment.
      if (files.length) promoteReviewPreview(taskId);
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
      // A reject ALSO resets the attempt budget: it opens a new work cycle on the
      // same session, so the turn-end safety net (auto-continue with the "deliver
      // now" nudge) must be available again. Without this, attempts carried over
      // from the previous cycle arrive already exhausted and the first premature
      // turn-end skips the nudge — the system force-delivers instead of letting
      // the agent reach review on its own.
      if (decision === "reject") {
        db.prepare("UPDATE tasks SET status = ?, completed_at = NULL, dispatch_state = NULL, dispatch_attempts = 0, updated_at = ? WHERE id = ?")
          .run(target, ts, taskId);
      } else {
        db.prepare("UPDATE tasks SET status = ?, completed_at = ?, dispatch_state = NULL, updated_at = ? WHERE id = ?")
          .run(target, ts, ts, taskId);
      }
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

    boardProjectForTopic(topicId) {
      if (!topicId) return null;
      // A live dispatch binds exactly one task to the topic; prefer a non-archived
      // one and the most recent if history ever left more than one.
      const r = db.prepare(
        `SELECT project_id FROM tasks
          WHERE assigned_topic_id = ?
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(topicId) as any;
      return r?.project_id ?? null;
    },

    taskForTopic(topicId) {
      if (!topicId) return null;
      const r = db.prepare(
        `SELECT id, project_id, text FROM tasks
          WHERE assigned_topic_id = ?
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(topicId) as any;
      return r ? { id: r.id, projectId: r.project_id, text: r.text ?? "" } : null;
    },

    taskByIdPrefix(id8) {
      const p = (id8 ?? "").trim();
      // id8 is a hex slice of a uuid → no LIKE metacharacters to escape.
      if (!/^[0-9a-f]{1,32}$/i.test(p)) return null;
      const r = db.prepare(
        `SELECT id, text FROM tasks
          WHERE id LIKE ? || '%'
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(p) as any;
      return r ? { id: r.id, text: r.text ?? "" } : null;
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
      // Clear any stale dispatch failure state: a 'failed'/'blocked' park (and its
      // dispatch_error) was about the SOURCE board's dispatch context — moving the
      // task to another board invalidates it, so it must not travel as a red
      // "fallito"/"da sistemare" chip. (Live dispatch states are already refused
      // above, so this only ever clears a settled park.)
      db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         )
         UPDATE tasks SET project_id = ?, dispatch_state = NULL, dispatch_error = NULL, updated_at = ? WHERE id IN (SELECT id FROM subtree)`,
      ).run(taskId, target, ts);
      // Re-append the root at the end of the target board; children keep their
      // relative order (kanban_order is just a per-board sort key).
      db.prepare("UPDATE tasks SET kanban_order = ? WHERE id = ?").run((maxRow?.m ?? 0) + 1, taskId);
      return rowToTask(getTaskRow(taskId));
    },

    claim({ taskId, cap, maxAttempts, agentId, scope }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // Concurrency cap: count tasks already claimed by a dispatch (in_progress
      // with a live dispatch chip). Per-board by default; scope 'global' counts
      // across EVERY board so a machine-wide cap holds no matter how many boards
      // dispatch at once. The task itself is still `todo` here, so it is not in
      // the count. bun:sqlite is synchronous + single-process, so this
      // read-then-CAS is atomic w.r.t. other claims.
      const running = (scope === "global"
        ? db.prepare(
            "SELECT COUNT(*) AS c FROM tasks WHERE status = 'in_progress' AND dispatch_state IN ('starting','working') AND archived = 0",
          ).get()
        : db.prepare(
            "SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND status = 'in_progress' AND dispatch_state IN ('starting','working') AND archived = 0",
          ).get(row.project_id)) as any;
      if ((running.c as number) >= cap) return null;
      const ts = now();
      const res = db.prepare(
        `UPDATE tasks
            SET assigned_agent_id = ?, status = 'in_progress',
                in_progress_at = ?, dispatch_state = 'starting',
                dispatch_attempts = dispatch_attempts + 1, dispatch_error = NULL, updated_at = ?
          WHERE id = ? AND status = 'todo' AND assigned_topic_id IS NULL AND dispatch_attempts < ?
            AND (blocked_by_task_id IS NULL OR EXISTS (
                  SELECT 1 FROM tasks bk
                   WHERE bk.id = tasks.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1)))`,
      ).run(agentId ?? null, ts, ts, taskId, maxAttempts);
      if (res.changes !== 1) return null; // lost the race / not todo / attempts exhausted
      logStatus(taskId, "todo", "in_progress", "dispatcher");
      return rowToTask(getTaskRow(taskId));
    },

    bumpDispatchAttempt({ taskId, maxAttempts }): Task | null {
      const res = db.prepare(
        `UPDATE tasks
            SET dispatch_attempts = dispatch_attempts + 1, updated_at = ?
          WHERE id = ? AND status = 'in_progress' AND assigned_topic_id IS NOT NULL AND dispatch_attempts < ?`,
      ).run(now(), taskId, maxAttempts);
      if (res.changes !== 1) return null; // cap hit, moved, or claim gone
      return rowToTask(getTaskRow(taskId));
    },

    listBlockedBy(taskId): Task[] {
      const rows = db.prepare(
        "SELECT * FROM tasks WHERE blocked_by_task_id = ? AND archived = 0",
      ).all(taskId) as any[];
      return rows.map(rowToTask);
    },

    isDispatchBlocked(taskId): boolean {
      const r = db.prepare(
        `SELECT 1 AS b FROM tasks t
          WHERE t.id = ? AND t.blocked_by_task_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tasks bk
                             WHERE bk.id = t.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1))`,
      ).get(taskId);
      return !!r;
    },

    release({ taskId, requeue, reason, by, parkState, rollbackAttempt }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // Note first (so the "worked in topic X" trail survives clearing the link).
      if (reason && reason.trim()) {
        try { this.addComment({ taskId, author: by ?? "system", content: reason }); } catch { /* dedupe/best-effort */ }
      }
      const ts = now();
      const status: TaskStatus = requeue ? "todo" : "backlog";
      // Requeue shows the 'in coda' chip; a park carries an EXPLICIT state so the
      // board can tell a genuine FAILURE ('failed') from a config BLOCK ('blocked')
      // — both used to collapse to null and read as a manual "fermato".
      const state = requeue ? "queued" : (parkState ?? null);
      // A restart-orphan requeue rolls back the interrupted attempt: the server
      // restarting is never the agent's fault, so it must not erode the retry
      // budget (that was the "il task torna in backlog per errore" after deploys).
      const rollbackSql = rollbackAttempt ? "dispatch_attempts = MAX(dispatch_attempts - 1, 0), " : "";
      db.prepare(
        `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL, ${rollbackSql}
            status = ?, dispatch_state = ?, dispatch_error = ?, updated_at = ? WHERE id = ?`,
      ).run(status, state, reason ?? null, ts, taskId);
      if (row.status !== status) logStatus(taskId, row.status, status, by ?? "dispatcher");
      return rowToTask(getTaskRow(taskId));
    },

    deliverToReviewBySystem({ taskId, reason }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const ts = now();
      // Note first so the "why it's here" is the last word on the review card.
      if (reason && reason.trim()) {
        try { this.addComment({ taskId, author: "system", content: reason }); } catch { /* best-effort */ }
      }
      // Hand to the human: keep assigned_topic_id (a rejection resumes this
      // agent), clear the stale error, chip = needs_input (a decision is wanted).
      db.prepare(
        "UPDATE tasks SET status = 'review', dispatch_state = 'needs_input', dispatch_error = NULL, updated_at = ? WHERE id = ?",
      ).run(ts, taskId);
      if (row.status !== "review") logStatus(taskId, row.status, "review", "dispatcher");
      // Open the pending review approval so the review decision flow works, just
      // like an agent-initiated hand-off would.
      try {
        db.prepare(
          `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
           VALUES (?, ?, 'dispatcher', 'review', ?, 'done', 'pending', ?)`,
        ).run(uuid(), taskId, row.status, ts);
      } catch { /* an existing pending approval is fine */ }
      return rowToTask(getTaskRow(taskId));
    },

    bindTopic({ taskId, topicId }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET assigned_topic_id = ?, chat_id = ?, updated_at = ? WHERE id = ?")
        .run(topicId, topicId, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    recordAgentUsage({ taskId, addMs, addTokens, addCacheReadTokens }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const ms = Math.max(0, Math.trunc(addMs || 0));
      const tok = Math.max(0, Math.trunc(addTokens || 0));
      const cr = Math.max(0, Math.trunc(addCacheReadTokens || 0));
      db.prepare(
        "UPDATE tasks SET agent_ms = agent_ms + ?, agent_tokens = agent_tokens + ?, agent_cache_read_tokens = agent_cache_read_tokens + ?, updated_at = ? WHERE id = ?",
      ).run(ms, tok, cr, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    setDispatchState({ taskId, state, error }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET dispatch_state = ?, dispatch_error = ?, updated_at = ? WHERE id = ?")
        .run(state, error ?? null, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    setModel({ taskId, model }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET model = ?, updated_at = ? WHERE id = ?")
        .run(model || null, now(), taskId);
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

    getGlobalCap(): { auto: boolean; max: number } {
      const r = db.prepare("SELECT max_agents, max_agents_auto FROM board_settings WHERE project_id = ?").get(GLOBAL_SETTINGS_KEY) as any;
      // Auto is the default until a manual number is explicitly picked (NULL = never
      // set → auto), so a fresh install caps concurrency by capacity, not at nothing.
      const auto = r?.max_agents_auto == null ? true : !!r.max_agents_auto;
      return { auto, max: clampInt(r?.max_agents ?? 3, 1, 20) };
    },

    setGlobalCap(patch: { auto?: boolean; max?: number }): { auto: boolean; max: number } {
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 3)").run(GLOBAL_SETTINGS_KEY);
      if (patch.auto !== undefined) {
        db.prepare("UPDATE board_settings SET max_agents_auto = ? WHERE project_id = ?").run(patch.auto ? 1 : 0, GLOBAL_SETTINGS_KEY);
      }
      if (patch.max !== undefined) {
        db.prepare("UPDATE board_settings SET max_agents = ? WHERE project_id = ?").run(clampInt(patch.max, 1, 20), GLOBAL_SETTINGS_KEY);
      }
      return this.getGlobalCap();
    },

    getBoardSettings(projectId: string): BoardSettings {
      const r = db.prepare("SELECT * FROM board_settings WHERE project_id = ?").get(projectId) as any;
      return {
        projectId,
        autoDispatch: readGlobalDispatch(),
        maxAgents: r ? (r.max_agents ?? 2) : 2,
        maxAgentsAuto: r ? !!r.max_agents_auto : false,
        dispatchEffort: r?.dispatch_effort ?? "medium",
        dispatchUseWorktree: r ? !!r.dispatch_use_worktree : true,
        dispatchAutoMerge: r ? !!r.dispatch_auto_merge : false,
        dispatchTimeoutMin: r?.dispatch_timeout_min ?? 20,
        dispatchMcp: r?.dispatch_mcp ?? "bridge-only",
        dispatchModel: r?.dispatch_model ?? "auto",
        dispatchRetryCap: r?.dispatch_retry_cap ?? 2,
        dispatchRetryBackoffS: r?.dispatch_retry_backoff_s ?? 60,
        requireApprovalForDone: r ? !!r.require_approval_for_done : false,
        requireReviewBeforeDone: r ? !!r.require_review_before_done : false,
      };
    },

    updateBoardSettings(projectId: string, patch: UpdateBoardSettingsPatch): BoardSettings {
      if (!projectId) throw new TaskServiceError("invalid_input", "projectId is required");
      if (patch.dispatchEffort !== undefined && !VALID_EFFORT.has(patch.dispatchEffort)) {
        throw new TaskServiceError("invalid_input", `invalid effort "${patch.dispatchEffort}"`);
      }
      if (patch.dispatchMcp !== undefined && !VALID_DISPATCH_MCP.has(patch.dispatchMcp)) {
        throw new TaskServiceError("invalid_input", `invalid dispatchMcp "${patch.dispatchMcp}"`);
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
      if (patch.maxAgentsAuto !== undefined) { sets.push("max_agents_auto = ?"); params.push(patch.maxAgentsAuto ? 1 : 0); }
      if (patch.dispatchEffort !== undefined) { sets.push("dispatch_effort = ?"); params.push(patch.dispatchEffort); }
      if (patch.dispatchUseWorktree !== undefined) { sets.push("dispatch_use_worktree = ?"); params.push(patch.dispatchUseWorktree ? 1 : 0); }
      if (patch.dispatchAutoMerge !== undefined) { sets.push("dispatch_auto_merge = ?"); params.push(patch.dispatchAutoMerge ? 1 : 0); }
      if (patch.dispatchTimeoutMin !== undefined) { sets.push("dispatch_timeout_min = ?"); params.push(clampInt(patch.dispatchTimeoutMin, 1, 120)); }
      if (patch.dispatchMcp !== undefined) { sets.push("dispatch_mcp = ?"); params.push(patch.dispatchMcp); }
      // 'auto' (or empty) collapses to NULL so the classifier keeps picking; any other
      // string pins the board to that model id. No allowlist here — the model set is
      // provider-driven (see /api/claude/models); an unknown id simply fails at spawn.
      if (patch.dispatchModel !== undefined) { sets.push("dispatch_model = ?"); params.push(patch.dispatchModel && patch.dispatchModel !== "auto" ? patch.dispatchModel : null); }
      if (patch.dispatchRetryCap !== undefined) { sets.push("dispatch_retry_cap = ?"); params.push(clampInt(patch.dispatchRetryCap, 1, 5)); }
      if (patch.dispatchRetryBackoffS !== undefined) { sets.push("dispatch_retry_backoff_s = ?"); params.push(clampInt(patch.dispatchRetryBackoffS, 10, 600)); }
      if (sets.length) db.prepare(`UPDATE board_settings SET ${sets.join(", ")} WHERE project_id = ?`).run(...params, projectId);
      return this.getBoardSettings(projectId);
    },
  };
}

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
import { parseReviewChecks, serializeReviewChecks, type CheckRun } from "./review-checks";

// Stati e forma del thread stanno in `shared/board.ts`: il client li legge
// dalla stessa dichiarazione invece di riscriverli. `export type … from`
// ri-esporta ma NON porta i nomi in scope locale, e qui sotto servono — da cui
// l'import separato. Della lista `TASK_STATUSES` questo modulo non è una porta:
// chi la vuole la prende da `shared/board`.
export type { TaskStatus, TaskComment, BoardSettings, BoardSettingsPatch } from "../../shared/board";
import { MAX_FANOUT, TASK_STATUSES, isAgentWorking } from "../../shared/board";
import { EFFORT_TIERS } from "../../shared/effort";
import type { TaskStatus, TaskComment, BoardSettings, BoardSettingsPatch } from "../../shared/board";

export type Actor = "human" | "agent";

const STATUSES: readonly TaskStatus[] = TASK_STATUSES;

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
  /** Agent-declared external-condition wait: while this timestamp is in the
   *  future the task sits in `todo` (chip `waiting`) and is NOT dispatch-eligible;
   *  the tick re-claims it once the window passes. null = no wait. */
  dispatchDeferredUntil: string | null;
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
  /** Lo sforzo con cui il task ha girato davvero (dal topic dell'agente). Sola
   *  lettura: con la board su `auto` è l'unico posto in cui la scelta si vede. */
  effort: string | null;
  /** Dependency: not dispatch-eligible until this task is done/archived. */
  blockedByTaskId: string | null;
  /** Branch the task delivered on, snapshotted at the transition into `review`. */
  deliveryBranch: string | null;
  /** Branch tip at delivery time — the handle that outlives the reaped branch. */
  deliveryCommit: string | null;
  /** Landing audit verdict: is the delivered content actually on main?
   *  null = never audited (pre-audit task, or no delivery recorded). */
  landingState: "landed" | "unlanded" | "unverifiable" | null;
  landingCheckedAt: string | null;
  /**
   * Esito dei checks pre-review. null = mai girati (board senza check, task senza
   * worktree, task precedenti al gate) — che NON è un verde e non va disegnato come
   * tale. 'running' mentre il server li esegue.
   */
  checksState: "running" | "pass" | "fail" | null;
  checksAt: string | null;
  /** Il commit su cui sono girati: se il branch è avanzato, un 'pass' è scaduto. */
  checksCommit: string | null;
  /** Evidenza per il reviewer: comando per comando, esito, durata e coda dell'output. */
  checks: CheckRun[] | null;
  /**
   * Chi ha portato il task in review l'ultima volta. `'system'` è il caso che
   * cambia la domanda del reviewer: non è una consegna, è un turno finito male
   * (tentativi esauriti, modello che si rifiuta) che qualcuno deve guardare —
   * e può non esserci nessun deliverable sotto. null = mai passato di lì.
   */
  deliveredBy: "agent" | "human" | "system" | null;
  /** Perché, in forma leggibile da codice. Solo per `deliveredBy === 'system'`;
   *  la prosa completa resta nel commento di sistema del thread. */
  deliveredReason: "retries_exhausted" | "model_refused" | "fanout" | null;
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
  /**
   * Re-nest under another task; null detaches back to a root card. Unlike at
   * creation, the id already exists and CAN be an ancestor of the new parent,
   * so the chain is walked (see `assertParentValid`). Refused while the task
   * has live work: a subtask is a step of the parent's checklist that the
   * dispatcher never claims on its own, so demoting a running card would leave
   * its agent turning with nobody watching it.
   */
  parentTaskId?: string | null;
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


/**
 * Il patch è DERIVATO da `BoardSettings` in `shared/board.ts`: elencarne i campi
 * a mano voleva dire tenere allineate due liste (e il client ne teneva una terza,
 * già indietro di due campi).
 */
export type UpdateBoardSettingsPatch = BoardSettingsPatch;

/**
 * `tasks.checks_json` → `CheckRun[]`. Tollerante come il parser delle impostazioni:
 * un JSON storto (riga scritta a mano, formato di una versione precedente) vale
 * "nessuna evidenza", non un'eccezione che fa esplodere OGNI lettura del task.
 */
function parseChecksJson(raw: unknown): CheckRun[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? (parsed as CheckRun[]) : null;
  } catch { return null; }
}

/**
 * L'effort di board accetta anche `auto`, come il modello.
 *
 * Fissarlo per tutta una board significa pagare lo stesso sforzo su un typo e su
 * un refactor — e non e' una differenza teorica: misurato il 2026-08-09 sullo
 * stesso micro-task, `medium` costa 61,1k token di lavoro e `xhigh` 108,8k. Su
 * `auto` lo sceglie il classificatore task per task (`task-model-picker.ts`),
 * con pavimento a `medium` cosi' non puo' peggiorare niente in silenzio.
 */
const VALID_EFFORT = new Set<string>([...EFFORT_TIERS, "auto"]);
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
  addComment(args: { taskId: string; author: string; content: string; mentions?: string[]; media?: string[]; projectId?: string; questionOptions?: string[]; kind?: "comment" | "review-note" }): TaskComment;
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
  /**
   * Il sistema porta in review un task che l'agente non ha consegnato da solo.
   * `cause` è la causa in forma leggibile da codice: la UI ci scrive sopra
   * l'avviso giusto senza dover interpretare la prosa di `reason`.
   */
  deliverToReviewBySystem(args: {
    taskId: string;
    reason: string;
    cause?: "retries_exhausted" | "model_refused" | "fanout";
  }): Task;
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
  /**
   * Agent-declared external-condition wait: release the slot and put the task
   * back in `todo` with chip `waiting` and a `dispatch_deferred_until` window,
   * so it is NOT re-claimed until the window passes (then the tick re-dispatches
   * it fresh). Distinct from a review hand-off: it produced no deliverable, it is
   * just waiting — the note explains for what. `minutes` is clamped to [1, 1440].
   */
  deferForWait(args: { taskId: string; reason: string; minutes?: number; by?: string }): Task;
  /** Overwrite the topic binding of a claimed task (dispatcher: placeholder → real topic). */
  bindTopic(args: { taskId: string; topicId: string }): Task;
  /** Update just the dispatch state/error (queued|starting|working|needs_input). */
  setDispatchState(args: { taskId: string; state: string | null; error?: string | null }): Task;
  /** Persist the model actually resolved for a run (auto-pick → concrete id) so
   *  the card stops showing "auto" once the agent has run. */
  setModel(args: { taskId: string; model: string | null }): Task;
  /** Accumulate agent effort on the task (dispatcher, at each turn end). */
  recordAgentUsage(args: { taskId: string; addMs: number; addTokens: number; addCacheReadTokens?: number }): Task;
  /**
   * Snapshot what the agent delivered, at the moment it delivers it (→ review).
   * The branch is reaped once it lands, so the COMMIT is the only durable handle
   * the landing audit can hold onto. Re-recorded on every new delivery (a
   * reject→resume→review round trip delivers a new tip).
   */
  recordDelivery(args: { taskId: string; branch: string | null; commit: string | null }): void;
  /** Esito dei checks pre-review sul task (evidenza per il reviewer). */
  recordChecks(args: {
    taskId: string;
    state: "running" | "pass" | "fail" | null;
    commit?: string | null;
    runs?: CheckRun[] | null;
  }): Task;
  /** Tasks worth auditing: alive, delivered (review/done) and carrying a commit. */
  listLandingAuditCandidates(): Array<{ id: string; projectId: string; deliveryBranch: string | null; deliveryCommit: string | null }>;
  /** Persist a landing-audit verdict. */
  recordLandingState(args: { taskId: string; state: "landed" | "unlanded" | "unverifiable"; checkedAt: string }): void;
  /** How many alive tasks are delivered but provably NOT on main (board badge). */
  countUnlanded(projectId?: string): number;
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

  /**
   * Lo sforzo con cui il task ha girato DAVVERO.
   *
   * Gemello di `resolveModel`, e per la stessa ragione: con la board su `auto`
   * lo sceglie il classificatore task per task, e senza questo la scelta non si
   * vede da nessuna parte — né sulla card né nell'API, solo nel log del server.
   * Una decisione dinamica che non si può ispezionare è peggio di una fissa: è
   * la leva più cara che abbiamo (stesso lavoro: `medium` 61,1k token, `xhigh`
   * 108,8k), e non poterla leggere significa non poter verificare un conto.
   *
   * Non c'è una colonna `tasks.effort` e non serve: l'autorità è il TOPIC, che è
   * ciò che viene davvero passato allo spawn. Duplicarla su `tasks` creerebbe
   * due verità libere di divergere.
   */
  function resolveEffort(r: any): string | null {
    if (!r.assigned_topic_id) return null;
    try {
      const t = db.prepare("SELECT effort FROM topics WHERE id = ?").get(r.assigned_topic_id) as { effort?: string | null } | undefined;
      return t?.effort ?? null;
    } catch { /* topics stub senza colonna effort (test) */ }
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
      dispatchDeferredUntil: r.dispatch_deferred_until ?? null,
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
      effort: resolveEffort(r),
      blockedByTaskId: r.blocked_by_task_id ?? null,
      deliveryBranch: r.delivery_branch ?? null,
      deliveryCommit: r.delivery_commit ?? null,
      landingState: r.landing_state ?? null,
      landingCheckedAt: r.landing_checked_at ?? null,
      checksState: r.checks_state ?? null,
      checksAt: r.checks_at ?? null,
      checksCommit: r.checks_commit ?? null,
      checks: parseChecksJson(r.checks_json),
      deliveredBy: r.delivered_by ?? null,
      deliveredReason: r.delivered_reason ?? null,
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
    const kind: TaskComment["kind"] = r.kind === "status" ? "status" : r.kind === "review-note" ? "review-note" : "comment";
    return { id: r.id, taskId: r.task_id, author: r.author, content: r.content, mentions, media, createdAt: r.created_at, kind };
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

  // Re-parenting. At creation the walk is unnecessary (a fresh id can never be
  // an ancestor of an existing row); MOVING an existing task can close a loop —
  // nest A under its own child and the pair disappears from the board, because
  // `rootsOnly` shows neither and the detail tree recurses forever.
  function assertParentValid(taskId: string, parentId: string): void {
    const self = getTaskRow(taskId);
    const parent = getTaskRow(parentId);
    if (!self) throw new TaskServiceError("not_found", `task ${taskId} not found`);
    if (!parent || parent.project_id !== self.project_id || parent.archived) {
      // Same not_found shape as the create-side guard: no cross-board probing.
      throw new TaskServiceError("not_found", `parent task ${parentId} not found`);
    }
    if (parentId === taskId) {
      throw new TaskServiceError("invalid_input", "a task cannot be its own parent");
    }
    let cur: string | null = parent.parent_task_id ?? null;
    for (let hops = 0; cur && hops < 100; hops++) {
      if (cur === taskId) throw new TaskServiceError("invalid_input", "parent chain would form a cycle");
      cur = (getTaskRow(cur)?.parent_task_id ?? null) as string | null;
    }
  }

  return {
    create(input: CreateTaskInput): Task {
      const text = (input.text ?? "").trim();
      if (!text) throw new TaskServiceError("invalid_input", "task text is required");
      if (!input.projectId) throw new TaskServiceError("invalid_input", "projectId is required");

      // Default `backlog`, NON `todo`. `todo` è la coda di esecuzione: un task
      // che ci nasce fa partire un agente entro pochi secondi su un board con
      // auto-dispatch. Chi crea un task senza dire dove (MCP, uno script, una
      // integrazione) sta ANNOTANDO, non dando un via — e il default lo
      // trasformava in un ordine di esecuzione. Misurato il 03/08: tre task
      // creati da chat, tre agenti dispacciati in meno di 20 secondi; due si
      // sono fermati solo perché quei progetti non erano repo git, cioè per
      // caso e non per una guardia.
      //
      // "Vai" ora si scrive: `status: "todo"` esplicito. L'interfaccia lo passa
      // già sempre (si crea trascinando nella colonna, che È lo status), quindi
      // il cambio tocca solo i chiamanti esterni — esattamente il caso da
      // correggere.
      const status = input.status ?? "backlog";
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
        // Il task NON è più tuo: un agente a cui il dispatcher ha tolto il task
        // non può riprenderselo.
        //
        // `release()` azzera `assigned_topic_id` quando parcheggia o rimette in
        // coda — ma il TURNO dell'agente non muore con quella riga: continua a
        // girare, e la sua `update_task(status)` passava senza che nessuno
        // controllasse se quel task gli appartenesse ancora. Misurato: un task
        // parcheggiato alle 22:48 è tornato `in_progress` 79 secondi dopo ed è
        // rimasto lì SETTE GIORNI — nessun reaper lo guardava, perché per il DB
        // stava lavorando, e falsava anche la capacità di dispatch.
        //
        // La proprietà si misura come già fa il carve-out dei sottotask: o il
        // task è legato al tuo topic, o lo è un suo antenato (i passi della tua
        // checklist restano tuoi). Fuori da lì, rifiuto esplicito.
        //
        // Solo quando `agentTopicId` c'è: gli altri chiamanti (umano, sistema,
        // dispatcher) non hanno un topic con cui rivendicare niente, e questa
        // guardia non li riguarda.
        //
        // Due forme di "non è tuo", e servono entrambe:
        //  a) il task è legato a un ALTRO topic — è di un altro agente;
        //  b) il task non è legato a nessuno MA porta la firma di un rilascio
        //     del dispatcher (`queued` dopo un requeue, `failed`/`blocked` dopo
        //     un park). È il caso misurato: `release()` azzera il legame, e il
        //     turno che continua a girare tornava a prenderselo.
        //
        // Un task MAI dispacciato ha `assigned_topic_id` e `dispatch_state`
        // entrambi nulli: quello resta lavorabile: bloccarlo sarebbe impedire a
        // una sessione di lavorare su un task che nessuno le ha tolto.
        const releasedByDispatcher =
          row.assigned_topic_id == null
          && (row.dispatch_state === "queued" || row.dispatch_state === "failed" || row.dispatch_state === "blocked");
        const boundElsewhere = row.assigned_topic_id != null && row.assigned_topic_id !== agentTopicId;
        if (
          actor === "agent" && agentTopicId
          && (boundElsewhere || releasedByDispatcher)
          && !isOwnStep(taskId, agentTopicId)
        ) {
          throw new TaskServiceError(
            "task_not_yours",
            "questo task non è più assegnato a te (rimesso in coda o parcheggiato dal dispatcher): non puoi cambiarne lo stato. Se hai lavoro da consegnare, scrivilo come commento.",
          );
        }
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
      if (patch.parentTaskId !== undefined) {
        if (patch.parentTaskId) {
          assertParentValid(taskId, patch.parentTaskId);
          // NON `isAgentWorking`: quello include `queued`, che altrove ("zitto,
          // sta lavorando") è la risposta giusta ma qui è la sbagliata. Una card
          // in coda non ha ancora nessuna sessione — nidificarla la toglie
          // semplicemente dalla coda, che è esattamente ciò che si vuole
          // accorpando. Il rifiuto riguarda un turno che sta GIRANDO: quello sì
          // resterebbe orfano, perché un sottotask non lo dispaccia più nessuno.
          if (row.dispatch_state === "working" || row.dispatch_state === "starting" || row.status === "in_progress") {
            throw new TaskServiceError(
              "invalid_input",
              "task has live work: a subtask is never dispatched on its own, so stop the agent before nesting it under a parent",
            );
          }
          // Un sottotask non è in coda per niente: il chip 'queued' resterebbe
          // acceso su una card che il dispatcher non guarderà mai più.
          if (row.dispatch_state === "queued") put("dispatch_state", null);
        }
        put("parent_task_id", patch.parentTaskId || null);
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
        if (patch.status === "review" && isAgentWorking(row.dispatch_state)) {
          put("dispatch_state", "delivered");
        }
        // Chi ha consegnato. Una card in review consegnata dall'agente e una
        // portata lì dal sistema pongono al reviewer due domande diverse, e oggi
        // hanno lo stesso aspetto. `deliverToReviewBySystem` scrive 'system' per
        // conto suo; qui passa solo chi ha spinto il bottone davvero.
        // `delivered_reason` si azzera: è la causa di QUESTA consegna, e questa
        // non è di sistema.
        if (patch.status === "review" && current !== "review") {
          put("delivered_by", actor);
          put("delivered_reason", null);
        }
        // A HUMAN dragging a task into todo is a fresh mandate: reset the
        // retry budget. Without this, a task parked at the cap could never be
        // re-dispatched — the claim filter skipped it and the card stranded
        // on "in coda" forever. Agents don't get to refresh their own retries.
        if (patch.status === "todo" && actor === "human") put("dispatch_attempts", 0);
      }
      put("updated_at", now());

      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, taskId);
      // Un task che ESCE da review si porta dietro la sua richiesta di
      // approvazione: va chiusa qui.
      //
      // `reviewDecision` era l'UNICO punto che la risolveva, ma non e' l'unica
      // strada per uscire da review — c'e' il trascinamento sulla board, c'e'
      // `update({status})` da MCP, c'e' l'archiviazione. Su ognuna di quelle la
      // riga restava 'pending' per sempre: misurate 13 approvazioni appese su
      // 48, di cui 9 su task gia' 'done'. Gonfiavano il conteggio dei "pending"
      // e nessuno le avrebbe mai chiuse, perche' il task non e' piu' in review e
      // `reviewDecision` lo rifiuta.
      //
      // L'esito NON e' sempre lo stesso: arrivare a 'done' e' cio' che
      // l'approvazione chiedeva, quindi 'approved'; ogni altra destinazione
      // rende la domanda priva di oggetto — 'expired', non 'rejected', perche'
      // nessun umano ha detto no. 'expired' e' gia' ammesso dal CHECK della
      // tabella e finora non lo usava nessuno.
      if (patch.status !== undefined && current === "review" && patch.status !== "review") {
        db.prepare(
          `UPDATE approvals SET status = ?, reviewed_by = ?, reviewed_at = ?
             WHERE task_id = ? AND approval_type = 'review' AND status = 'pending'`,
        ).run(patch.status === "done" ? "approved" : "expired", by, now(), taskId);
      }
      // Status history: every applied transition lands in the thread with its
      // author — the timeline answers "chi l'ha spostato e quando".
      if (patch.status !== undefined && patch.status !== current) logStatus(taskId, current, patch.status, by);
      // Hand-off into review without an explicit preview: promote the
      // delivery comment's evidence (comment-first delivery order).
      if (patch.status === "review") promoteReviewPreview(taskId);
      return rowToTask(getTaskRow(taskId));
    },

    addComment({ taskId, author, content, mentions, media, projectId, questionOptions, kind }): TaskComment {
      const commentKind: "comment" | "review-note" = kind === "review-note" ? "review-note" : "comment";
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
        "INSERT INTO task_comments (id, task_id, author, content, mentions, media, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, taskId, author, body, mentions && mentions.length ? JSON.stringify(mentions) : null, files.length ? JSON.stringify(files) : null, commentKind, ts);
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
      if (row.assigned_topic_id || isAgentWorking(row.dispatch_state)) {
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
                dispatch_attempts = dispatch_attempts + 1, dispatch_error = NULL,
                dispatch_deferred_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'todo' AND assigned_topic_id IS NULL AND dispatch_attempts < ?
            AND (dispatch_deferred_until IS NULL OR dispatch_deferred_until <= ?)
            AND (blocked_by_task_id IS NULL OR EXISTS (
                  SELECT 1 FROM tasks bk
                   WHERE bk.id = tasks.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1)))`,
      ).run(agentId ?? null, ts, ts, taskId, maxAttempts, ts);
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

    deferForWait({ taskId, reason, minutes, by }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const mins = clampInt(minutes ?? 15, 1, 1440);
      const ts = now();
      const until = new Date(Date.parse(ts) + mins * 60_000).toISOString();
      const note =
        (reason && reason.trim() ? `In attesa: ${reason.trim()}. ` : "In attesa di una condizione esterna. ") +
        `Rilascio lo slot, il task torna in coda e riprovo tra ~${mins} min.`;
      // Note first (author = the agent by default) so the "perché è fermo" trail
      // survives clearing the topic link.
      try { this.addComment({ taskId, author: by ?? "agent", content: note }); } catch { /* dedupe/best-effort */ }
      // Back to todo, slot freed (topic/agent cleared), chip `waiting`, and a
      // deferral window that keeps it out of the claim until it elapses. No
      // attempt is consumed here — waiting is not a failure (the fresh re-claim
      // bumps the attempt, which naturally bounds an endlessly-waiting task).
      db.prepare(
        `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL,
            status = 'todo', dispatch_state = 'waiting', dispatch_error = ?,
            dispatch_deferred_until = ?, updated_at = ? WHERE id = ?`,
      ).run(note, until, ts, taskId);
      if (row.status !== "todo") logStatus(taskId, row.status, "todo", by ?? "agent");
      return rowToTask(getTaskRow(taskId));
    },

    deliverToReviewBySystem({ taskId, reason, cause }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const ts = now();
      // Note first so the "why it's here" is the last word on the review card.
      if (reason && reason.trim()) {
        try { this.addComment({ taskId, author: "system", content: reason }); } catch { /* best-effort */ }
      }
      // Hand to the human: keep assigned_topic_id (a rejection resumes this
      // agent), clear the stale error, chip = needs_input (a decision is wanted).
      // `delivered_by = 'system'`: la card in review deve dire da sé che non è una
      // consegna dell'agente — sotto può non esserci nessun deliverable.
      db.prepare(
        "UPDATE tasks SET status = 'review', dispatch_state = 'needs_input', dispatch_error = NULL, " +
          "delivered_by = 'system', delivered_reason = ?, updated_at = ? WHERE id = ?",
      ).run(cause ?? null, ts, taskId);
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

    recordChecks({ taskId, state, commit, runs }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare(
        "UPDATE tasks SET checks_state = ?, checks_at = ?, checks_commit = ?, checks_json = ?, updated_at = ? WHERE id = ?",
      ).run(
        state,
        // 'running' non ha un "quando è finito": scriverne uno direbbe una cosa
        // falsa alla riga "verdi alle 14:32".
        state === "running" ? null : now(),
        commit ?? null,
        runs && runs.length ? JSON.stringify(runs) : null,
        now(),
        taskId,
      );
      return rowToTask(getTaskRow(taskId));
    },

    recordDelivery({ taskId, branch, commit }): void {
      // A new delivery invalidates any previous verdict: re-audit from scratch
      // rather than leave a stale "landed" on top of fresh, unlanded commits.
      db.prepare(
        "UPDATE tasks SET delivery_branch = ?, delivery_commit = ?, landing_state = NULL, landing_checked_at = NULL WHERE id = ?",
      ).run(branch || null, commit || null, taskId);
    },

    listLandingAuditCandidates() {
      return db.prepare(
        `SELECT id, project_id, delivery_branch, delivery_commit
           FROM tasks
          WHERE archived = 0 AND delivery_commit IS NOT NULL
            AND status IN ('review', 'done')`,
      ).all().map((r: any) => ({
        id: r.id,
        projectId: r.project_id,
        deliveryBranch: r.delivery_branch ?? null,
        deliveryCommit: r.delivery_commit ?? null,
      }));
    },

    recordLandingState({ taskId, state, checkedAt }): void {
      db.prepare("UPDATE tasks SET landing_state = ?, landing_checked_at = ? WHERE id = ?")
        .run(state, checkedAt, taskId);
    },

    countUnlanded(projectId?: string): number {
      const sql =
        "SELECT COUNT(*) AS n FROM tasks WHERE archived = 0 AND landing_state = 'unlanded'" +
        (projectId ? " AND project_id = ?" : "");
      const r = (projectId ? db.prepare(sql).get(projectId) : db.prepare(sql).get()) as any;
      return r?.n ?? 0;
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
        language: r?.language ?? "inherit",
        // NULL = 1: una board che non ha mai sentito parlare di fan-out dispaccia
        // un agente per task, com'è sempre stato.
        dispatchFanOut: Math.max(1, r?.dispatch_fanout ?? 1),
        dispatchRetryCap: r?.dispatch_retry_cap ?? 2,
        dispatchRetryBackoffS: r?.dispatch_retry_backoff_s ?? 60,
        requireApprovalForDone: r ? !!r.require_approval_for_done : false,
        requireReviewBeforeDone: r ? !!r.require_review_before_done : false,
        reviewChecks: parseReviewChecks(r?.review_checks),
        nightMode: r ? !!r.night_mode : false,
        nightModeUntil: r?.night_mode_until ?? "",
        nightModeStartedAt: r?.night_mode_started_at ?? null,
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
      if (patch.language !== undefined) { sets.push("language = ?"); params.push(patch.language && patch.language !== "inherit" ? patch.language : null); }
      // Tetto a 5: oltre, il fan-out non è più "confronto fra alternative" ma un
      // modo di saturare la macchina — e ogni tentativo è un agente vero che
      // occupa uno slot del tetto globale.
      if (patch.dispatchFanOut !== undefined) { sets.push("dispatch_fanout = ?"); params.push(clampInt(patch.dispatchFanOut, 1, MAX_FANOUT)); }
      // Accendere la modalità notturna STAMPA l'istante: senza, «fino alle
      // 10:00» non si sa se sia stamattina o domani mattina. Spegnendola si
      // cancella, così un riaccendere non eredita una scadenza vecchia.
      if (patch.nightMode !== undefined) {
        sets.push("night_mode = ?"); params.push(patch.nightMode ? 1 : 0);
        sets.push("night_mode_started_at = ?"); params.push(patch.nightMode ? now() : null);
      }
      if (patch.nightModeUntil !== undefined) {
        const v = String(patch.nightModeUntil ?? "").trim();
        sets.push("night_mode_until = ?"); params.push(v || null);
      }
      if (patch.dispatchRetryCap !== undefined) { sets.push("dispatch_retry_cap = ?"); params.push(clampInt(patch.dispatchRetryCap, 1, 5)); }
      if (patch.dispatchRetryBackoffS !== undefined) { sets.push("dispatch_retry_backoff_s = ?"); params.push(clampInt(patch.dispatchRetryBackoffS, 10, 600)); }
      // NULL, non `[]`: "gate spento" è UNO stato solo, e due modi di scriverlo
      // sono due modi di leggerlo sbagliato.
      if (patch.reviewChecks !== undefined) { sets.push("review_checks = ?"); params.push(serializeReviewChecks(patch.reviewChecks)); }
      if (sets.length) db.prepare(`UPDATE board_settings SET ${sets.join(", ")} WHERE project_id = ?`).run(...params, projectId);
      return this.getBoardSettings(projectId);
    },
  };
}

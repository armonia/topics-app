/**
 * server/services/task-shapes.ts - the DATA SHAPES of a board task, split out
 * of `tasks.ts`.
 *
 * WHY, measured. `check:bloat` exists because a file two people cannot edit at
 * the same time is a lock (the reasoning is at the top of
 * `scripts/check-bloat.ts`). `tasks.ts` crossed its ceiling by two lines at
 * 5.763, and 407 of those lines were these four declarations: the row a task
 * IS, plus the three inputs that create it, patch it and list it. They are the
 * contract that the routes, the client and the tests read; the service is what
 * implements that contract. Keeping them at the same address meant a branch
 * adding one column met a branch rewriting dispatch logic, for no reason other
 * than the filename.
 *
 * `tasks.ts` re-exports all four, so every existing import keeps working.
 */
import type { CheckRun } from "./review-checks";
import type { TaskLabelRow } from "../../shared/task-labels";
import type {
  TaskStatus,
  CardComment,
  BlockerRef,
  SubtaskWork,
  QueueReason,
  TaskWeight,
} from "../../shared/board";

export interface Task {
  id: string;
  projectId: string;
  text: string;
  description: string | null;
  /**
   * The first characters of `description`, and what the CARD actually draws:
   * the box clips it to two lines, and the feed used to ship 470 KB of full
   * text (out of 1.4 MB) just so the client could shorten it.
   *
   * Always present, even when `description` is too: the `list` path computes it
   * with a SQL `substr`, the single-row paths by slicing the string. Whoever
   * draws a card reads THIS; whoever opens the detail reads `description`,
   * which `svc.get` carries whole.
   */
  descriptionPreview: string | null;
  status: TaskStatus;
  priority: number;
  kanbanOrder: number;
  assignedTo: string | null;
  dueDate?: string;
  chatId?: string;
  createdAt: string;
  completedAt?: string;
  updatedAt: string;
  /**
   * ON THE WIRE, not in the fixed body: it travels only when it has a value.
   * Here `null` is not a state - absent and never-checked are the same thing.
   */
  claudeTaskId?: string;
  assignedTopicId: string | null;
  /** null = never dispatched; queued | starting | working | needs_input. */
  dispatchState: string | null;
  dispatchAttempts: number;
  dispatchError: string | null;
  /** Agent-declared external-condition wait: while this timestamp is in the
   *  future the task sits in `todo` (chip `waiting`) and is NOT dispatch-eligible;
   *  the tick re-claims it once the window passes. null = no wait. */
  dispatchDeferredUntil: string | null;
  /**
   * Declared waits counted on a scale of THEIR own, not on attempts.
   *
   * `waitStreak` is the number of consecutive waits for the same reason,
   * `waitReason` is that reason normalised (it changes => the streak restarts
   * at one) and `waitSince` is when the streak began. Past either cap
   * (`WAIT_STREAK_CAP`, `WAIT_SERIES_MAX_MS`) the task parks with a
   * `waited_out` chip: stopped, yes; failed, no.
   */
  waitStreak: number;
  waitReason: string | null;
  waitSince: string | null;
  /**
   * How hard this task bites the MACHINE while it runs (migration 090), as the
   * classifier read it the last time the task was dispatched. `null` = never
   * classified, and every gate treats that as `light` - which is how the
   * dispatcher behaved before the weight existed.
   */
  dispatchWeight: TaskWeight | null;
  /** Parent task (nested subtask, unlimited depth). Set at creation only. */
  parentTaskId: string | null;
  /** Reviewable output (http/https URL) shown in the task's review panel. */
  outputUrl?: string;
  /**
   * Result of the last server-side probe on output_url.
   * - `'live'`    : the probe answered 2xx/3xx
   * - `'dead'`    : the probe does not answer, or answers 4xx/5xx
   * - `'unknown'` : never probed (the default after the migration)
   * `null` = no output_url, the field does not apply.
   */
  urlProbeStatus: 'live' | 'dead' | 'unknown' | null;
  /** Timestamp of the last probe (ISO string). */
  /**
   * ON THE WIRE, not in the fixed body: it travels only when it has a value.
   * Here `null` is not a state - absent and never-checked are the same thing.
   */
  urlProbeCheckedAt?: string;
  /** Screenshot of the delivery (absolute allowlisted path, served by
   *  /api/media) - the thumbnail on the Kanban card. */
  previewImage: string | null;
  /** THE OTHER evidence attached in the thread, for the card's carousel.
   *
   *  ABSENT, not empty, when there is none. The gate on list weight (`lean
   *  projection`, 1750 bytes per task) caught me: two always-present fields
   *  cost 7 bytes per task on EVERY response, for a case that concerns one card
   *  in ten. `[]` and `undefined` read the same downstream - the client does
   *  `?? []` - but only one of them travels. */
  previewImages?: string[];
  /**
   * The preview was RETIRED because it was not evidence (a duplicate, a
   * placeholder, a mistake). It is a state of the card, not a message in the
   * thread: it clears itself as soon as a new preview arrives, which a note
   * written once cannot do. `null` = it never happened.
   */
  previewRetiredAt: string | null;
  previewRetiredReason: string | null;
  /** Paths the retirement rejected: back neither as cover nor as a slide. */
  previewRejected: string[];
  /** Dispatch contract: deliver a PLAN to review before implementing. */
  planFirst: boolean;
  /** THE comment that IS the plan (the "Piano" tab renders this one, not
   *  whichever comment happens to be last). `addComment` writes it when it
   *  recognises the plan-first contract; `null` on tasks born before this
   *  pointer existed. */
  planCommentId?: string;
  /** When the current claim started (dispatcher CAS) - the live "it is taking
   *  this long" ticker anchors here while a turn runs. */
  inProgressAt?: string;
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
  /** The effort the task actually ran with (from the agent's topic). Read
   *  only: with the board on `auto` this is the only place the choice shows. */
  effort: string | null;
  /** Dependency: not dispatch-eligible until this task is done/archived. */
  blockedByTaskId: string | null;
  /**
   * The same blocker, RESOLVED from the DB. The client's "waiting on" chip is
   * drawn from here: the board list (one project, `rootsOnly`, not archived) is
   * not a reliable source for the blocker's title, so whoever has the DB at
   * hand resolves it. `null` = no link, or the row pointed at no longer exists
   * (an orphan edge).
   */
  blockedBy: BlockerRef | null;
  /**
   * Who works this subtask when it has no agent of its own - DERIVED from the
   * chain of parents, not from a column. `null` = the question does not arise
   * (not a subtask, not in progress, or it already has a topic/chip).
   *
   * It separates the two faces of an `in_progress` card with neither topic nor
   * chip: an ancestor works it inside its own turn (`parent-turn`, the intended
   * flow and the norm), or nobody works it (`unattended`, rare but real - and
   * invisible until now, because orphan recovery filters on the dispatch chip
   * which in this shape is absent).
   */
  subtaskWork: SubtaskWork | null;
  /**
   * The other half of the link: how many tasks are waiting on THIS one, counted
   * on the DB. The "N waiting" chip on the card is drawn from here, for the
   * same reason as `blockedBy`: the board list is a single project, `rootsOnly`,
   * not archived - a dependent that is a subtask or lives in another project
   * does not appear in it, and counting that list made the link vanish from
   * exactly the card where you decide whether to close the work.
   *
   * It counts LIVE dependents: not archived and not `done` - the ones the
   * dispatch gate still holds back, and that start again when this one closes.
   */
  waitingOnCount: number;
  /**
   * WHY this card is stuck in `todo`, in a sentence already written. `null`
   * outside `todo`, or with an agent already in flight (there the dispatch chip
   * speaks).
   *
   * It arrives RESOLVED from the server for the same reason as `blockedBy` and
   * `waitingOnCount`, plus one that is its own: the decision not to dispatch is
   * the dispatcher's, and a client deducing it from the fields would state
   * yesterday's rule with a confident face the day that rule changes. Two of
   * the three ingredients are not even on the row - the dispatch switch and the
   * position in the queue, which is machine-wide while the client's list is a
   * single project.
   *
   * It has NOTHING to do with the `visibile`/`invisibile`/`decisione` labels:
   * those say WHO closes the card and are derived at delivery. This one says
   * why it has not started yet.
   */
  queueReason: QueueReason | null;
  /** Branch the task delivered on, snapshotted at the transition into `review`. */
  deliveryBranch: string | null;
  /** Branch tip at delivery time — the handle that outlives the reaped branch. */
  deliveryCommit: string | null;
  reviewAt: string | null;
  deliveryFilesChanged: number | null;
  deliveryInsertions: number | null;
  deliveryDeletions: number | null;
  /** Landing audit verdict: is the delivered content actually on main?
   *  null = never audited (pre-audit task, or no delivery recorded). */
  landingState: "landed" | "unlanded" | "unverifiable" | null;
  /**
   * ON THE WIRE, not in the fixed body: it travels only when it has a value.
   * Here `null` is not a state - absent and never-checked are the same thing.
   */
  landingCheckedAt?: string;
  /** Deploy proposed at approve (see `BoardSettings.deployCommand`). `null` =
   *  never proposed; the "Deploya ora" button only renders on `'proposed'`. */
  deployState: "proposed" | "running" | "deployed" | "failed" | null;
  /** Command frozen at propose time, so a later settings edit cannot change
   *  what a pending "Deploya ora" is about to run. */
  deployCommandAtPropose?: string;
  /**
   * Result of the pre-review checks. null = never run (board without checks,
   * task without a worktree, tasks older than the gate) - which is NOT a green
   * and must not be drawn as one. 'running' while the server executes them.
   */
  checksState: "running" | "pass" | "fail" | "unknown" | null;
  /** How far the run of checks has got, while `checksState` is `running`.
   *  ABSENT when no run is in flight or when progress is unknown: a zero here
   *  would say "no command done", which is a different claim, and an explicit
   *  `null` would cost bytes on every task for a rare case. */
  checksProgress?: { done: number; total: number } | null;
  checksAt: string | null;
  /** The commit they ran on: if the branch moved on, a 'pass' has expired. */
  checksCommit: string | null;
  /** Evidence for the reviewer: command by command, result, duration and the tail of the output. */
  checks: CheckRun[] | null;
  /**
   * Who last moved the task into review. `'system'` is the case that changes
   * the reviewer's question: it is not a delivery, it is a turn that ended
   * badly (attempts exhausted, a model that refuses) and that somebody has to
   * look at - and there may be no deliverable underneath at all. null = it
   * never went through there.
   */
  deliveredBy: "agent" | "human" | "system" | null;
  /** Why, in a form code can read. Only for `deliveredBy === 'system'`; the
   *  full prose stays in the thread's system comment. */
  deliveredReason: "retries_exhausted" | "model_refused" | "fanout" | "parked_children" | null;
  /**
   * Who last brought the card to `done`. `'human'` = a decision of Attilio's
   * (an approval in review, or a drag on the board), and it counts as one: an
   * agent does not override it. `'agent'` = a checklist step the agent closed
   * by itself, never through a review - that one stays its own and it may
   * reopen it. null = never closed, or history without an approval (migration
   * 097 fills in only what it can prove).
   */
  doneActor: "human" | "agent" | "system" | null;
  /**
   * The card LEFT `done`: when, by whose hand and in what role. It lives until
   * the card is `done` again (then the cycle closes and the mark is cleared).
   * It is the trace that was missing - the reason for a reopening lived in the
   * thread, and whoever looked at the column saw only a hole where a finished
   * thing had been.
   */
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenedActor: "human" | "agent" | "system" | null;
  /** Dispatch in the BLOCKER agent's conversation instead of a fresh topic. */
  reuseBlockerContext: boolean;
  /** Direct-children counters (filled by list/get for board badges). */
  subtaskCount: number;
  subtaskDoneCount: number;
  /** Human interactions in the thread: comments authored by 'user' (kind
   *  'comment') — excludes the AI/agent, system notes and status events. Filled
   *  by list/get; the card shows it as a "how many messages did I send" count. */
  userCommentCount: number;
  /**
   * The labels (migration 100), with WHO wrote them. `visibile`, `decisione`
   * and `invisibile` decide who closes the card and are DERIVED from the diff
   * at delivery; the rest (`bugfix` `feature` `chore` `misura`) are there to
   * filter. The vocabulary and the rule live in `shared/task-labels.ts` - here
   * there is only the reading.
   */
  labels: TaskLabelRow[];
  /**
   * The last SPOKEN comments of the thread (up to three), oldest to newest.
   * `kind: 'status'` and `kind: 'service'` stay out: they are the history of
   * the transitions and the dispatcher's bookkeeping, not anybody's words - the
   * same cut (`isThreadSpeech`) the client uses to choose which pair to show on
   * the card.
   *
   * It exists because the board opened a full `GET /api/tasks/:id` for EVERY
   * card in review just to read the bottom of the thread, and that detail loads
   * the WHOLE thread. It rides on every payload - including the writes the
   * server echoes over the WS - for the same reason as `waitingOnCount`: a
   * field filled only by `list`/`get` would go dark on every WS round until the
   * next fetch.
   *
   * EMPTY outside review: that is the only column that draws them
   * (`drawsCardComments`). Empty because there are none and empty because
   * nobody is looking read the same - and rightly so: whoever opens the thread
   * asks `svc.get`, which carries it whole.
   */
  recentComments: CardComment[];
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
  /**
   * PROVENANCE: the topic that created the task (migration 093). Only the
   * session surface writes it, from the topic resolved server-side - an agent
   * cannot declare it. Written once and never rewritten: it is what keeps your
   * own steps closable even after the dispatcher has reshuffled the
   * assignments (see `isOwnStep`).
   */
  createdByTopicId?: string | null;
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
  /** Screenshot for the card (absolute path); empty string / null clears it.
   *  The gate on the media allowlist lives in the route layer (like comment media). */
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
  /**
   * With `rootsOnly`: put the ORPHANED steps back into the cut - the ones whose
   * parent is closed, archived or gone.
   *
   * `rootsOnly` has two consumers with two different needs, and under a single
   * name it served only one. For the DISPATCHER it is a safety rule ("Steps are
   * never dispatch-eligible"): widening it means an agent launched on a step.
   * For the board FEED it is a reading rule: a step is not backlog, it is
   * somebody's checklist - and that "somebody's" stops being true the moment
   * the parent closes.
   *
   * No dispatcher picks up an orphaned step, its parent is in Done so nobody
   * opens that tree any more, and `parkedChildRaisedStall` returns immediately
   * on a closed parent. Keeping it out of the columns does not defer it: it
   * loses it.
   *
   * Defaults to `false` - that is, pure `rootsOnly`, the previous behaviour -
   * and that is not cosmetic caution: erring in this direction leaves an orphan
   * hidden (today's state), erring in the other starts an agent on a step. It
   * is switched on by whoever draws columns, never by whoever dispatches.
   */
  includeOrphanSubtasks?: boolean;
  /**
   * Filter by label, in AND: a task passes only if it has them ALL. The use
   * case that asked for it is "show me only the visible ones in review" - the
   * list Attilio actually has to look at - and it combines with `status`, which
   * is the column. Empty/absent = no filter.
   */
  labels?: readonly string[];
  /**
   * `true` = ONLY the archived ones, `false`/absent = only the live ones. Same
   * model as projects (`project-store.list({ archived })`), not a third verb:
   * the default list stays what it was, and whoever wants to see what they
   * archived asks for it. Before, there was no way to ask at all, so archiving
   * a task was a one-way door.
   */
  archived?: boolean;
  /**
   * ONLY these ids. It exists for the GUEST feed, which may see the cards
   * shared with them and nothing else: it used to hydrate every task in the
   * database and then keep two of them in JS, that is, pay for the whole board
   * to answer "two cards". An EMPTY set means "no rows", not "no filter".
   */
  ids?: readonly string[];
  /**
   * WITH the whole `description`. Off by default: the list carries
   * `descriptionPreview` and nothing else, because that is what the card draws
   * (the box clips it to two lines) — it was 470 KB out of the feed's 1.4 MB.
   *
   * The switch stayed because two readers really do read the whole text and not
   * a preview: the incoming link proposal (`proposeLink`, which compares
   * descriptions) and the list an agent sees, where a description cut at 240
   * characters without saying so is worse than an absent one. Whoever draws
   * cards never turns it on.
   */
  withDescription?: boolean;
}

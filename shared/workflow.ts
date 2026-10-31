/**
 * BOARD WORKFLOWS: which columns a board shows, declared once for both ends of
 * the wire (the board-workflows proposal under `openspec/changes`).
 *
 * A column is a STAGE on top of one of the five base statuses. `tasks.status`
 * stays what it was (the DB CHECK, the dispatcher's claim on `todo`, the MCP
 * enum and the tray all keep reading it), and the nullable `tasks.stage` says
 * which of the columns sharing that status the card sits in. A card with no
 * stage, or with a stage the board's workflow does not have, sits in the
 * default column of its status: that is how every card born before workflows
 * keeps its place.
 *
 * Workflows are PRESETS, not a free editor: `default` is the five columns of
 * before, so no board changes until somebody picks another one. The level is
 * the project, with a global default (`'*'`); a folder is a project of its own
 * today (`projectIdForPath` hashes the path), so the folder level is not here.
 */

import { splitCreatedBy } from './created-by';
import { commentAuthorLabel } from './comment-author';
import { TASK_STATUSES, isThreadSpeech, parseQuestionBlock, questionAsksHuman, type TaskStatus } from './board';

export interface WorkflowColumn {
  /** Stable id: equal to the base status for the plain columns. */
  id: string;
  /** Header label (English, like `STATUS_LABEL`). */
  label: string;
  /** The status a card in this column has in the DB. */
  base: TaskStatus;
  /**
   * Holds only the cards that NAME it (`tasks.stage`). A card with no stage
   * never lands here by default: `ai_review` would otherwise swallow every
   * card delivered before the workflow existed, which were all waiting on a
   * person.
   */
  explicitOnly?: boolean;
}

export const WORKFLOW_PRESET_IDS = ['default', 'armonia'] as const;
export type WorkflowPresetId = (typeof WORKFLOW_PRESET_IDS)[number];

/** Reserved scope of the global row, the same key `board_settings` uses. */
export const GLOBAL_WORKFLOW_SCOPE = '*';

/** Stage ids with a meaning on the server, not just a header. */
export const STAGE_TRIAGE = 'triage';
export const STAGE_AI_REVIEW = 'ai_review';
export const STAGE_HUMAN_REVIEW = 'human_review';

const STATUS_COLUMN_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

const plain = (s: TaskStatus): WorkflowColumn => ({ id: s, label: STATUS_COLUMN_LABEL[s], base: s });

export const WORKFLOW_PRESETS: Record<WorkflowPresetId, readonly WorkflowColumn[]> = {
  default: TASK_STATUSES.map(plain),
  // Triage takes the backlog: a card opened by a person or from a chat lands
  // there and is triaged (title, priority, dependency, missing information)
  // before it reaches Todo. AI review sits on `review` but only holds the cards
  // routed there; Human review is the default review column, so it is the one
  // the tray and the waiting-on-you list count.
  armonia: [
    { id: STAGE_TRIAGE, label: 'Triage', base: 'backlog' },
    plain('todo'),
    plain('in_progress'),
    { id: STAGE_AI_REVIEW, label: 'AI review', base: 'review', explicitOnly: true },
    { id: STAGE_HUMAN_REVIEW, label: 'Human review', base: 'review' },
    plain('done'),
  ],
};

export function isWorkflowPresetId(v: unknown): v is WorkflowPresetId {
  return typeof v === 'string' && (WORKFLOW_PRESET_IDS as readonly string[]).includes(v);
}

export interface BoardWorkflow {
  preset: WorkflowPresetId;
  /** Where the preset came from: the project row, the global row, or neither. */
  source: 'project' | 'global' | 'default';
  columns: readonly WorkflowColumn[];
}

/** The project row wins over the global one; neither = `default`. Unknown ids are ignored. */
export function resolveWorkflow(rows: { project?: string | null; global?: string | null }): BoardWorkflow {
  if (isWorkflowPresetId(rows.project)) return { preset: rows.project, source: 'project', columns: WORKFLOW_PRESETS[rows.project] };
  if (isWorkflowPresetId(rows.global)) return { preset: rows.global, source: 'global', columns: WORKFLOW_PRESETS[rows.global] };
  return { preset: 'default', source: 'default', columns: WORKFLOW_PRESETS.default };
}

export function workflowHasStage(columns: readonly WorkflowColumn[], stage: string): boolean {
  return columns.some((c) => c.id === stage);
}

/** The column that hosts cards of `status` with no stage of their own. */
export function defaultColumnFor(columns: readonly WorkflowColumn[], status: TaskStatus): WorkflowColumn | null {
  return columns.find((c) => c.base === status && !c.explicitOnly) ?? null;
}

/**
 * The column a card is drawn in. Its stage when the workflow has it AND the
 * stage agrees with the status (a stale stage never drags a card out of the
 * column its status says); otherwise the default column of its status.
 */
export function columnOfTask(
  columns: readonly WorkflowColumn[],
  task: { status: TaskStatus; stage?: string | null },
): WorkflowColumn | null {
  if (task.stage) {
    const named = columns.find((c) => c.id === task.stage);
    if (named && named.base === task.status) return named;
  }
  return defaultColumnFor(columns, task.status);
}

/**
 * Does this card wait on a PERSON? A card in review does, unless it is in AI
 * review, where whoever opened it closes it. This is what the tray's review
 * group and the waiting-on-you list count, on every workflow: on `default` no card has
 * that stage, so the count is the one of before.
 */
export function awaitsHuman(task: { status: string; stage?: string | null }): boolean {
  return task.status === 'review' && task.stage !== STAGE_AI_REVIEW;
}

/**
 * Where a card is born on a board with a triage column. Only a card born in
 * backlog: one created straight into Todo has already been given the «go».
 * A card from a person (`human`, or no label: a chat or an internal path) is
 * triaged; one an agent or a schedule opened is triaged only when it arrives
 * incomplete, that is without an explicit priority or without a description
 * (where the acceptance bar lives). `null` = no stage.
 */
export function stageAtBirth(
  columns: readonly WorkflowColumn[],
  card: { status: TaskStatus; createdBy?: string | null; complete?: boolean; humanAsk?: string | null },
): string | null {
  // Born in review it is a delivery: a machine card without a question is
  // born in AI review, back to whoever opened it (KANBAN-102).
  if (card.status === 'review') return stageForDelivery(columns, card) === STAGE_AI_REVIEW ? STAGE_AI_REVIEW : null;
  if (card.status !== 'backlog' || !workflowHasStage(columns, STAGE_TRIAGE)) return null;
  const who = splitCreatedBy(card.createdBy ?? null);
  if (!who || who.kind === 'human') return STAGE_TRIAGE;
  return card.complete ? null : STAGE_TRIAGE;
}

/**
 * Where an agent's delivery lands. On a board with AI review, a card opened by
 * an agent or a schedule goes back to whoever opened it (the rule of 28/10:
 * whoever opens a card closes it); it reaches Human review only with a question for the
 * person (`humanAsk`), and a card a person opened goes to them directly.
 * `null` = no stage (the plain Review column).
 */
export function stageForDelivery(
  columns: readonly WorkflowColumn[],
  card: { createdBy?: string | null; humanAsk?: string | null },
): string | null {
  if (!workflowHasStage(columns, STAGE_AI_REVIEW)) return null;
  const who = splitCreatedBy(card.createdBy ?? null);
  const openedByMachine = !!who && who.kind !== 'human';
  if (openedByMachine && !(card.humanAsk ?? '').trim()) return STAGE_AI_REVIEW;
  return workflowHasStage(columns, STAGE_HUMAN_REVIEW) ? STAGE_HUMAN_REVIEW : null;
}

/**
 * The stage a status change WITHOUT a named column lands in: a move into
 * review is a delivery (`stageForDelivery`), any other the default column.
 * Except a CLOSED card taken back into review by anyone but an agent: that is
 * the land withdrawing a card already accepted, and the comment it leaves asks
 * the PERSON to fix and land again. Routed like a delivery, a machine card
 * went back to AI review, out of the tray and of the waiting-on-you list.
 */
export function stageForStatusChange(
  columns: readonly WorkflowColumn[],
  move: { from: TaskStatus; to: TaskStatus; byAgent: boolean; createdBy?: string | null; humanAsk?: string | null },
): string | null {
  if (move.to !== 'review') return null;
  if (move.from === 'done' && !move.byAgent) return null;
  return stageForDelivery(columns, move);
}

/**
 * A card born in review that NAMES Human review (or its default column,
 * `stage: null`) while the routing above would send it to AI review: a
 * machine card with no question for the person. Refused, as on `update`.
 */
export function namesHumanReviewWithoutAsk(
  columns: readonly WorkflowColumn[],
  card: { status: TaskStatus; createdBy?: string | null; humanAsk?: string | null; stage?: string | null },
): boolean {
  if (card.status !== 'review' || card.stage === undefined) return false;
  if (stageForDelivery(columns, card) !== STAGE_AI_REVIEW) return false;
  return (card.stage || defaultColumnFor(columns, 'review')?.id) === STAGE_HUMAN_REVIEW;
}

/**
 * The question an AGENT left for the person as the thread's last word, or
 * `null`. This is how most agents ask: a comment with `options`, not
 * `human_ask` on the delivery, so the routing above reads both. The board's
 * own notes (system, dispatcher, verifier) are skipped, since they are
 * written under the agent's word; a person speaking after it means the
 * question was already answered. Options that are only board actions
 * («Landa su main») are a delivery, not a question (`questionAsksHuman`).
 */
export function agentAskInThread(comments: readonly { author?: string | null; content: string; kind?: string | null }[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (!isThreadSpeech(c)) continue;
    const who = commentAuthorLabel(c.author).kind;
    if (who === 'system' || who === 'dispatcher' || who === 'verifier') continue;
    if (who !== 'agent') return null;
    const q = parseQuestionBlock(c.content);
    return q && questionAsksHuman(q) ? q.question : null;
  }
  return null;
}

/**
 * How long a card may sit in AI review, untouched, before the coordinator is
 * reminded of it (`sweepStaleAiReview`). The first notice goes out the moment
 * the card enters the column; this is the one for a notice nobody acted on, or
 * lost to a restart.
 */
export const AI_REVIEW_REMIND_MS = 30 * 60 * 1000;

/**
 * How long after a reminder that reached nobody the sweep tries it again. A
 * floor, not a schedule: without it a board with no coordinator to wake would
 * log the same failed reminder at every reconcile.
 */
export const AI_REVIEW_RETRY_MS = 5 * 60 * 1000;

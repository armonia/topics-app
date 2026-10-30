/**
 * BOARD WORKFLOWS: which columns a board shows, declared once for both ends of
 * the wire (proposal `openspec/changes/workflow-per-progetto`).
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
import { TASK_STATUSES, type TaskStatus } from './board';

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
  // the tray and «Ti aspetta» count.
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
 * group and «Ti aspetta» count, on every workflow: on `default` no card has
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
  card: { status: TaskStatus; createdBy?: string | null; complete?: boolean },
): string | null {
  if (card.status !== 'backlog' || !workflowHasStage(columns, STAGE_TRIAGE)) return null;
  const who = splitCreatedBy(card.createdBy ?? null);
  if (!who || who.kind === 'human') return STAGE_TRIAGE;
  return card.complete ? null : STAGE_TRIAGE;
}

/**
 * Where an agent's delivery lands. On a board with AI review, a card opened by
 * an agent or a schedule goes back to whoever opened it (the rule of 28/10:
 * «chi apre chiude»); it reaches Human review only with a question for the
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

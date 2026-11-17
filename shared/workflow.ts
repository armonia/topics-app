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
 * There is ONE set of columns for every board (`WORKFLOW_COLUMNS`): the five
 * base ones plus CI. It used to be a preset a board could choose; the only
 * other one (`armonia`: Triage, AI review, Human review) was removed because
 * no board used it, and then the choice went away with it. A `board_workflows`
 * row left in a database is not read any more. What a board can still set are
 * the RULES beside the columns (`WorkflowRules`): the level is the project,
 * with a global default (`'*'`); a folder is a project of its own today
 * (`projectIdForPath` hashes the path), so the folder level is not here.
 */

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
   * never lands here by default: `ci` would otherwise swallow every card in
   * review, which are all waiting on a person.
   */
  explicitOnly?: boolean;
}

/** Reserved scope of the global rules row, the same key `board_settings` uses. */
export const GLOBAL_WORKFLOW_SCOPE = '*';

/**
 * The CI phase: the work was accepted (a person's Approva/Landa or the
 * automatic land) and waits for the integration queue to measure it together
 * with main and land it. Nobody has to look at it, so it is out of the
 * waiting-on-you count; it exists on every workflow.
 */
export const STAGE_CI = 'ci';
const CI_COLUMN: WorkflowColumn = { id: STAGE_CI, label: 'CI', base: 'review', explicitOnly: true };

/**
 * The one copy of the status words, shared by the client (`STATUS_LABEL` in
 * `client/src/lib/board.ts` re-exports it) and mirrored by the tray in
 * `desktop-tauri/src-tauri/src/lib.rs` (`tray_status_label`).
 */
export const STATUS_COLUMN_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

const plain = (s: TaskStatus): WorkflowColumn => ({ id: s, label: STATUS_COLUMN_LABEL[s], base: s });

/** The columns of every board, in the order they are drawn. */
export const WORKFLOW_COLUMNS: readonly WorkflowColumn[] = [...TASK_STATUSES.filter((s) => s !== 'done').map(plain), CI_COLUMN, plain('done')];

/** `GET /boards/:id/workflow`: the columns of the board and its resolved rules. */
export interface BoardWorkflow {
  columns: readonly WorkflowColumn[];
}

/**
 * A path a person must look at before a card touching it lands: a glob on the
 * repository path (`client/src/**`, `server/services/{a,b}.ts`) and why, in a
 * few words. The generic list (dependencies, CI, public text, security...)
 * lives in the code (`server/services/auto-land.ts`); a board adds what is
 * specific to its repository. A test file never needs a person, wherever it is.
 */
export interface PersonPath { pattern: string; why: string }

/** The rules of a workflow beside its columns. */
export interface WorkflowRules {
  /**
   * Accepted work is measured together with main in the CI column before it
   * lands. Takes effect only on a board with CI rows and auto-merge on.
   */
  ciPhase: boolean;
  /** This board's paths on top of the generic list: the global row's first, then the project's. */
  personPaths: PersonPath[];
}

/** One scope's row: `null`/absent = inherit (the global row, then the default). */
export interface WorkflowRulesRow { ciPhase?: boolean | null; personPaths?: PersonPath[] | null }

export const MAX_PERSON_PATHS = 200;

/** The project's CI switch wins over the global one (on by default); the paths add up. */
export function resolveWorkflowRules(rows: { project?: WorkflowRulesRow | null; global?: WorkflowRulesRow | null }): WorkflowRules {
  const ciPhase = rows.project?.ciPhase ?? rows.global?.ciPhase ?? true;
  return { ciPhase, personPaths: [...(rows.global?.personPaths ?? []), ...(rows.project?.personPaths ?? [])] };
}

/** A stored or sent list, checked; `null` when it is not a valid one. */
export function parsePersonPaths(v: unknown): PersonPath[] | null {
  if (!Array.isArray(v) || v.length > MAX_PERSON_PATHS) return null;
  const out: PersonPath[] = [];
  for (const x of v) {
    const pattern = typeof x?.pattern === 'string' ? x.pattern.trim() : '';
    const why = typeof x?.why === 'string' ? x.why.trim() : '';
    if (!pattern || pattern.length > 300 || why.length > 80) return null;
    out.push({ pattern, why: why || 'this board' });
  }
  return out;
}

/** The settings panel writes one path per line, `pattern # why`. */
export function personPathsToText(paths: readonly PersonPath[]): string {
  return paths.map((p) => `${p.pattern} # ${p.why}`).join('\n');
}

/** Back from the panel: blank lines and lines starting with `#` are skipped. */
export function personPathsFromText(text: string): PersonPath[] {
  const out: PersonPath[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cut = line.indexOf(' #');
    const pattern = (cut < 0 ? line : line.slice(0, cut)).trim();
    const why = cut < 0 ? '' : line.slice(cut + 2).trim();
    if (pattern) out.push({ pattern, why: why || 'this board' });
  }
  return out;
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
 * Does this card wait on a PERSON? A card in review does, unless it is in the
 * CI column, where the integration queue lands it and nobody has to look. This
 * is what the tray's review group and the waiting-on-you list count.
 */
export function awaitsHuman(task: { status: string; stage?: string | null }): boolean {
  return task.status === 'review' && task.stage !== STAGE_CI;
}

/**
 * `awaitsHuman` as a SQL condition, for the readers that count in the
 * database (the attention boot read, a parent's `subtaskReviewCount`). A
 * schema without the `stage` column has no CI column: plain `status`.
 * `alias` qualifies the columns (`t` gives `t.status`).
 */
export function awaitsHumanSql(hasStage: boolean, alias = ''): string {
  const c = alias ? `${alias}.` : '';
  return hasStage
    ? `(${c}status = 'review' AND (${c}stage IS NULL OR ${c}stage <> '${STAGE_CI}'))`
    : `${c}status = 'review'`;
}

/**
 * The question an AGENT left for the person as the thread's last word, or
 * `null`. This is how most agents ask: a comment with `options`, not
 * `human_ask` on the delivery, so the readers look at both. The board's
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

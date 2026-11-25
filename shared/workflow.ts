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
import { LAND_ACTION_LABEL, PLAN_REVISE_LABEL, TASK_STATUSES, isThreadSpeech, normalizeActionLabel, parseQuestionBlock, questionAsksHuman, type TaskStatus } from './board';

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
   * When accepted work meets the CI (`CiPhaseMode`). Takes effect only on a
   * board with CI rows and auto-merge on.
   */
  ciPhase: CiPhaseMode;
  /** This board's paths on top of the generic list: the global row's first, then the project's. */
  personPaths: PersonPath[];
  /** Minutes between scheduled reviews of technical cards sitting in review; 0 = off (the default). */
  scheduledReviewMinutes: number;
}

/**
 * When accepted work is measured by the CI:
 *  - `before`: measured together with main in the CI column, then it lands;
 *  - `after`: it lands at once, the CI measures main afterwards and a red goes back to the agent;
 *  - `off`: no CI phase, the land is the only step.
 */
export type CiPhaseMode = 'before' | 'after' | 'off';
export const CI_PHASE_MODES: readonly CiPhaseMode[] = ['before', 'after', 'off'];
export const DEFAULT_CI_PHASE: CiPhaseMode = 'after';

/** A mode, or the boolean the switch used to be (`true` = before, `false` = off); `null` when it is neither. */
export function parseCiPhase(v: unknown): CiPhaseMode | null {
  if (v === true) return 'before';
  if (v === false) return 'off';
  return typeof v === 'string' && (CI_PHASE_MODES as readonly string[]).includes(v) ? (v as CiPhaseMode) : null;
}

/** One scope's row: `null`/absent = inherit (the global row, then the default). A boolean is the old form of the switch. */
export interface WorkflowRulesRow { ciPhase?: CiPhaseMode | boolean | null; personPaths?: PersonPath[] | null; scheduledReviewMinutes?: number | null }

/** The scheduled review is off unless a board turns it on; no interval shorter than 10 minutes, none longer than a day. */
export const MIN_SCHEDULED_REVIEW_MINUTES = 10;
export const MAX_SCHEDULED_REVIEW_MINUTES = 1440;

/** An interval as stored or sent: 0 = off, otherwise whole minutes inside the bounds; `null` when it is neither. */
export function parseScheduledReviewMinutes(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  if (v === 0) return 0;
  return v >= MIN_SCHEDULED_REVIEW_MINUTES && v <= MAX_SCHEDULED_REVIEW_MINUTES ? v : null;
}

export const MAX_PERSON_PATHS = 200;

/** The project's CI mode wins over the global one (`after` by default); the paths add up. */
export function resolveWorkflowRules(rows: { project?: WorkflowRulesRow | null; global?: WorkflowRulesRow | null }): WorkflowRules {
  const ciPhase = parseCiPhase(rows.project?.ciPhase) ?? parseCiPhase(rows.global?.ciPhase) ?? DEFAULT_CI_PHASE;
  const scheduledReviewMinutes = parseScheduledReviewMinutes(rows.project?.scheduledReviewMinutes) ?? parseScheduledReviewMinutes(rows.global?.scheduledReviewMinutes) ?? 0;
  return { ciPhase, personPaths: [...(rows.global?.personPaths ?? []), ...(rows.project?.personPaths ?? [])], scheduledReviewMinutes };
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
    return q && questionAsksHuman(q) && !isApprovalOnly(q) ? q.question : null;
  }
  return null;
}

/**
 * A QUESTION WHOSE ONLY MEANING IS "DO YOU APPROVE?" IS NOT A QUESTION.
 *
 * Agents close almost every delivery with an "ok?": 684 fences offered
 * `Landa su main` in two weeks, and the variants the exact match misses keep a
 * green technical card waiting for a person who has nothing to decide, since
 * "land it, or tell me what to change" is what review offers anyway. Two shapes
 * count as approval only:
 *   - every option is the land action, marked or not ("Landa su main
 *     (consigliata)", "Landa su main a CI verde"), or its twin "send it back"
 *     (`Da rivedere`, "cosa cambiare");
 *   - no option (or a `human_ask`), and the WHOLE text is approval words ("Ok?",
 *     "Landa su main (consigliata) o cosa cambiare", "Ok a landare a CI
 *     verde?").
 * A text with anything else in it stays a question, however it ends. Measured
 * on the cards the log named as blocked by a question (25f0e2a5, b2b33bf0,
 * 48588f6e): each carried a real doubt before its closing "ok?" (ci.yml
 * inside the PR, what "forbidden" means, a script that measures something other
 * than the brief), so a reading that kept only the last sentence would have
 * landed three decisions nobody took. What only a person can judge does not
 * rest on this reading either: the interface is a person's by its paths, and
 * money, public text and real people's data by `human_ask`. With options, the
 * options decide only together with the text: options that are only "land it"
 * and "send it back" are approval when the text above them is a report (no
 * "?") or every sentence ending in "?" is approval words. A real question above
 * them (a product choice such as moving a retention from 30 to 90 days, or
 * "are the summary texts fine?") keeps it a question: the land
 * buttons would otherwise land a product choice nobody took. The list is small on purpose: a missed courtesy costs a person's
 * click, a swallowed question costs a land nobody wanted.
 */
const APPROVAL_WORDS = new Set(normalizeActionLabel(
  'ok okay va bene vanno cosi così posso landare landa landala landarla su main a ci verde consigliata consigliato recommended ' + // allow-italian: the words agents write, matched by value
  'rispondi oppure o dimmi dimmelo cosa cambiare approvi approva approvo procedo procedere ti tutto il la lo', // allow-italian: the words agents write, matched by value
).split(' '));
const LAND = normalizeActionLabel(LAND_ACTION_LABEL);
const SEND_BACK = normalizeActionLabel(PLAN_REVISE_LABEL);

/** The text asks nothing but "do you approve?": every word is an approval word (the rule above, for a text with no options). */
export function asksOnlyApproval(text: string): boolean {
  const words = normalizeActionLabel(text).split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => APPROVAL_WORDS.has(w));
}

/** Every sentence of `text` that ends in "?" is approval words only; a report with no "?" passes. */
function questionsOnlyApproval(text: string): boolean {
  return (text.match(/[^.?!\n]*\?/g) ?? []).every(asksOnlyApproval);
}

export function isApprovalOnly(q: { question?: string; options: readonly string[] }): boolean {
  if (q.options.length === 0) return asksOnlyApproval(q.question ?? '');
  if (!questionsOnlyApproval(q.question ?? '')) return false;
  return q.options.every((o) => {
    const n = normalizeActionLabel(o);
    return n === SEND_BACK || ((n.startsWith(LAND) || n.includes('cosa cambiare')) && asksOnlyApproval(o));
  });
}

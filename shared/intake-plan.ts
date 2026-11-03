/**
 * Multi-project intake: turns one written request into a PROPOSAL of cards.
 *
 * Pure and deterministic on purpose. Nothing here creates anything: the caller
 * shows the rows, the writer ticks and edits them, and only then `createRows`
 * creates the ticked ones (parents before children).
 *
 * Reading rules (the request is plain text):
 * - one line = one card; leading bullets and numbers are dropped;
 * - a line indented deeper than the previous top-level line is its sub-card;
 * - the project is named by a `@name` or `[name]` token, or by a `name:` prefix
 *   that matches a known project; a sub-card inherits its parent's project;
 * - a token that names no known project leaves the row UNRESOLVED (projectId
 *   null), never an invented project.
 */

export interface IntakeProject {
  projectId: string;
  name: string;
}

export interface IntakeRow {
  /** Stable within one proposal; sub-cards point at their parent by it. */
  key: string;
  title: string;
  /** null = unresolved: the writer must pick a project before confirming. */
  projectId: string | null;
  /** The name the writer typed when it matched nothing, for the row to show. */
  unresolvedName: string | null;
  /** Key of the row this one hangs under, or null for a top-level card. */
  parentKey: string | null;
  /** An EXISTING card this one goes under (chosen by the writer, never by default). */
  existingParentTaskId: string | null;
  /** An EXISTING card that goes under THIS one (this row becomes its parent). */
  existingChildTaskId: string | null;
  checked: boolean;
}

const BULLET = /^(?:[-*•]\s+|\d+[.)]\s+)/;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function findProject(name: string, projects: IntakeProject[]): IntakeProject | null {
  const n = normalize(name);
  if (!n) return null;
  return projects.find((p) => normalize(p.name) === n || normalize(p.projectId) === n) ?? null;
}

function indentOf(line: string): number {
  const lead = /^[ \t]*/.exec(line)![0];
  return lead.replace(/\t/g, '  ').length;
}

interface Parsed { title: string; projectId: string | null; unresolvedName: string | null; named: boolean }

function parseLine(raw: string, projects: IntakeProject[]): Parsed {
  let text = raw.trim().replace(BULLET, '').trim();
  let project: IntakeProject | null = null;
  let unresolvedName: string | null = null;
  let named = false;

  const token = /(?:^|\s)(?:@([\w.-]+)|\[([^\]]+)\])/;
  const m = token.exec(text);
  if (m) {
    named = true;
    const name = (m[1] ?? m[2]).trim();
    project = findProject(name, projects);
    if (!project) unresolvedName = name;
    text = text.replace(token, ' ').replace(/\s{2,}/g, ' ').trim();
  } else {
    const prefix = /^([^:\n]{1,40}):\s+(.+)$/.exec(text);
    const hit = prefix ? findProject(prefix[1], projects) : null;
    if (prefix && hit) {
      named = true;
      project = hit;
      text = prefix[2].trim();
    }
  }
  return { title: text, projectId: project?.projectId ?? null, unresolvedName, named };
}

/**
 * `defaultProjectId` is where an unnamed top-level line lands (the board the
 * writer is on). Returns [] for an empty request.
 */
export function proposeCards(request: string, projects: IntakeProject[], defaultProjectId: string | null): IntakeRow[] {
  const rows: IntakeRow[] = [];
  const stack: { indent: number; key: string; projectId: string | null }[] = [];
  for (const line of request.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseLine(line, projects);
    if (!parsed.title) continue;
    const indent = indentOf(line);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const key = `r${rows.length + 1}`;
    const projectId = parsed.named ? parsed.projectId : parent ? parent.projectId : defaultProjectId;
    rows.push({
      key,
      title: parsed.title,
      projectId,
      unresolvedName: parsed.unresolvedName,
      parentKey: parent ? parent.key : null,
      existingParentTaskId: null,
      existingChildTaskId: null,
      checked: true,
    });
    stack.push({ indent, key, projectId });
  }
  return rows;
}

/**
 * A sub-card ALWAYS follows its parent's project (the server rejects a child on
 * another board). Parents come before their children, so one pass settles every
 * depth. A parent that is unticked does not pull its child: that child is
 * created top-level and keeps its own project. A row whose project changed
 * loses an existing-card link that belonged to the old board.
 */
export function followParents(rows: IntakeRow[]): IntakeRow[] {
  const byKey = new Map<string, IntakeRow>();
  return rows.map((r) => {
    const parent = r.parentKey ? byKey.get(r.parentKey) : undefined;
    const next = parent && parent.checked
      ? { ...r, projectId: parent.projectId, unresolvedName: parent.projectId ? null : parent.unresolvedName }
      : r;
    byKey.set(next.key, next);
    return next;
  });
}

/**
 * Why the proposal cannot be confirmed yet, or null when it can. With `projects`
 * given, a ticked row on a project that is not among them blocks too.
 */
export function blockingReason(input: IntakeRow[], projects?: IntakeProject[]): string | null {
  const rows = followParents(input);
  const ticked = rows.filter((r) => r.checked);
  if (!ticked.length) return 'nothing ticked';
  if (ticked.some((r) => !r.projectId)) return 'a ticked row has no project';
  if (projects && ticked.some((r) => !projects.some((p) => p.projectId === r.projectId))) return 'a ticked row is on an unknown project';
  return null;
}

/**
 * The ticked rows in creation order: a parent always before its children. A
 * sub-card whose parent is unticked is created as a top-level card instead
 * (its `parentKey` is dropped), never silently lost.
 */
function orderForCreate(input: IntakeRow[], alreadyCreated: ReadonlySet<string> = new Set()): IntakeRow[] {
  const rows = followParents(input);
  const ticked = rows.filter((r) => r.checked);
  const keys = new Set([...ticked.map((r) => r.key), ...alreadyCreated]);
  return ticked.map((r) => (r.parentKey && !keys.has(r.parentKey) ? { ...r, parentKey: null } : r));
}

export interface IntakeCreateResult {
  created: { key: string; taskId: string; projectId: string }[];
  failed: { key: string; error: string }[];
  /** Rows not attempted because their parent failed. */
  skipped: string[];
  /** Cards that exist but could not take their existing child under them. */
  adoptFailed: { key: string; error: string }[];
}

/**
 * Creates the ticked rows one at a time, parents first. A failure is recorded
 * and its descendants are skipped; the rest still go through, and the result
 * says exactly what exists and what does not so the failed rows can be retried.
 * Rows already in `done` (a retry) are not created twice.
 */
export async function createRows(
  rows: IntakeRow[],
  create: (row: IntakeRow, parentTaskId: string | null) => Promise<string>,
  done: IntakeCreateResult['created'] = [],
  adopt?: (row: IntakeRow, newTaskId: string) => Promise<void>,
): Promise<IntakeCreateResult> {
  const result: IntakeCreateResult = { created: [...done], failed: [], skipped: [], adoptFailed: [] };
  const ids = new Map(done.map((d) => [d.key, d.taskId]));
  const dead = new Set<string>();
  for (const row of orderForCreate(rows, new Set(ids.keys()))) {
    if (ids.has(row.key)) continue;
    if (row.parentKey && dead.has(row.parentKey)) {
      dead.add(row.key);
      result.skipped.push(row.key);
      continue;
    }
    const parentTaskId = row.parentKey ? ids.get(row.parentKey) ?? null : row.existingParentTaskId;
    try {
      const taskId = await create(row, parentTaskId);
      ids.set(row.key, taskId);
      result.created.push({ key: row.key, taskId, projectId: row.projectId! });
      if (row.existingChildTaskId && adopt) {
        try { await adopt(row, taskId); } catch (e) {
          result.adoptFailed.push({ key: row.key, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      dead.add(row.key);
      result.failed.push({ key: row.key, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

function isListLine(line: string, projects: IntakeProject[]): boolean {
  return BULLET.test(line.trim()) || indentOf(line) > 0 || parseLine(line, projects).named;
}

/**
 * The gate for the panel: only a request that is a LIST (every line a bullet,
 * an indented sub-card or a line naming a project), splits into several cards,
 * and at least one line names a KNOWN project. A single line, or a title with a
 * prose body that happens to hold a `landing: ...` line, stays one card,
 * exactly as before.
 */
export function shouldPropose(request: string, projects: IntakeProject[]): boolean {
  const lines = request.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  if (!lines.every((l) => isListLine(l, projects))) return false;
  return lines.some((l) => parseLine(l, projects).projectId !== null);
}

export type SubmitAction = 'confirm-plan' | 'propose' | 'create';

/**
 * What Enter and the send button do. With the panel open they CONFIRM it and
 * never create a card of their own; only a list request opens the panel, and
 * `asSingle` (the writer chose "one card") skips the proposal.
 */
export function submitAction(planOpen: boolean, request: string, hasAttachments: boolean, projects: IntakeProject[] | null, asSingle = false): SubmitAction {
  if (planOpen) return 'confirm-plan';
  if (!asSingle && !hasAttachments && projects && shouldPropose(request, projects)) return 'propose';
  return 'create';
}

export type IntakeSubmit =
  | { kind: 'single' }
  | { kind: 'propose'; rows: IntakeRow[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'planned'; result: IntakeCreateResult };

export interface IntakeSubmitInput {
  /** The open proposal, or null when none is open. */
  planRows: IntakeRow[] | null;
  request: string;
  hasAttachments: boolean;
  projects: IntakeProject[] | null;
  /** Where an unnamed top-level line lands. */
  defaultProjectId: string | null;
  /** The writer chose to send the whole text as ONE card. */
  asSingle?: boolean;
  /** Rows already created by an earlier, partly failed confirm. */
  done?: IntakeCreateResult['created'];
  create: (row: IntakeRow, parentTaskId: string | null) => Promise<string>;
  adopt?: (row: IntakeRow, newTaskId: string) => Promise<void>;
}

/**
 * The single decision behind Enter and the send button. Nothing is created
 * until the writer confirmed a valid proposal: with the panel open it confirms
 * (and a proposal that cannot be confirmed creates nothing and says why), a
 * list request only OPENS the panel, and 'single' hands the one-card path back
 * to the caller.
 */
export async function submitIntake(i: IntakeSubmitInput): Promise<IntakeSubmit> {
  const action = submitAction(i.planRows !== null, i.request, i.hasAttachments, i.projects, i.asSingle);
  if (action === 'confirm-plan') {
    const rows = i.planRows ?? [];
    const reason = blockingReason(rows, i.projects ?? undefined);
    if (reason) return { kind: 'blocked', reason };
    return { kind: 'planned', result: await createRows(rows, i.create, i.done, i.adopt) };
  }
  if (action === 'propose' && i.projects) {
    const rows = proposeCards(i.request, i.projects, i.defaultProjectId);
    if (rows.length) return { kind: 'propose', rows };
  }
  return { kind: 'single' };
}

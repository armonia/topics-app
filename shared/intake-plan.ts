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
      checked: true,
    });
    stack.push({ indent, key, projectId });
  }
  return rows;
}

/** Why the proposal cannot be confirmed yet, or null when it can. */
export function blockingReason(rows: IntakeRow[]): string | null {
  const ticked = rows.filter((r) => r.checked);
  if (!ticked.length) return 'nothing ticked';
  if (ticked.some((r) => !r.projectId)) return 'a ticked row has no project';
  return null;
}

/**
 * The ticked rows in creation order: a parent always before its children. A
 * sub-card whose parent is unticked is created as a top-level card instead
 * (its `parentKey` is dropped), never silently lost.
 */
function orderForCreate(rows: IntakeRow[], alreadyCreated: ReadonlySet<string> = new Set()): IntakeRow[] {
  const ticked = rows.filter((r) => r.checked);
  const keys = new Set([...ticked.map((r) => r.key), ...alreadyCreated]);
  return ticked.map((r) => (r.parentKey && !keys.has(r.parentKey) ? { ...r, parentKey: null } : r));
}

export interface IntakeCreateResult {
  created: { key: string; taskId: string; projectId: string }[];
  failed: { key: string; error: string }[];
  /** Rows not attempted because their parent failed. */
  skipped: string[];
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
): Promise<IntakeCreateResult> {
  const result: IntakeCreateResult = { created: [...done], failed: [], skipped: [] };
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
    } catch (e) {
      dead.add(row.key);
      result.failed.push({ key: row.key, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * The gate for the panel: only a request that names a KNOWN project somewhere
 * is split into several cards. Plain multi-line text (a title and a body) stays
 * one card, exactly as before.
 */
export function namesKnownProject(request: string, projects: IntakeProject[]): boolean {
  return request.split(/\r?\n/).some((line) => parseLine(line, projects).projectId !== null);
}

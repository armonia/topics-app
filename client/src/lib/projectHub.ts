/**
 * THE PROJECT ROW'S HUB DATA (hub-smistamento, HUBBR-16): what the usage hub
 * knows of a project, read from the `projects` topic of the live store (the
 * hub's `/api/live`, trimmed by server/lib/hub-live.ts).
 *
 * A Topics project gets the hub's data only when the hub row is recognised as
 * that project: the same folder (the hub writes the home as `~`), or the same
 * name as the folder when the hub's folder is unknown or lies inside the
 * project (an agent working in one of its worktrees). Anything else shows
 * nothing: a wrong project's brake is worse than no brake at all.
 *
 * Pure on purpose: the wire shape and the match are the parts that can be
 * wrong in silence.
 */

/** The hub's priorities, compared by value. */
export const HUB_PRIORITY_LEVELS = ['alta', 'normale', 'bassa'] as const; // allow-italian: the hub's priority values
export type HubPriority = (typeof HUB_PRIORITY_LEVELS)[number];

/** What the row says of the project's state: held by the brake, waiting in the hub's line, or nothing. */
export type HubProjectHold = 'held' | 'queued' | null;

export interface HubProject {
  name: string;
  title: string;
  dir: string | null;
  hold: HubProjectHold;
  why: string;
  /** When the brake lets go, in ms; null when nobody knows. */
  waitUntil: number | null;
  /** Share of the week, in %, all providers together. */
  total: number;
  /** Your cap in % of the week; null when there is none. */
  budgetPct: number | null;
  priority: HubPriority;
}

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function holdOf(state: unknown): HubProjectHold {
  if (state === 'frenato') return 'held'; // allow-italian: the hub's state value
  if (state === 'in coda') return 'queued'; // allow-italian: the hub's state value
  return null;
}

/** The hub's projects, dropping what is not one; grouped temporary folders (`tmp:`) are never a Topics project. */
export function readHubProjects(data: unknown): HubProject[] {
  const list = isObject(data) ? data.projects : null;
  if (!Array.isArray(list)) return [];
  const out: HubProject[] = [];
  for (const p of list) {
    if (!isObject(p)) continue;
    const name = str(p.name);
    if (!name || name.startsWith('tmp:')) continue;
    const priority = (HUB_PRIORITY_LEVELS as readonly unknown[]).includes(p.priority) ? (p.priority as HubPriority) : 'normale';
    const budget = num(p.budgetPct);
    out.push({
      name,
      title: str(p.title) || name,
      dir: str(p.dir) || null,
      hold: holdOf(p.state),
      why: str(p.why),
      waitUntil: num(p.waitUntil),
      total: num(p.total) ?? 0,
      budgetPct: budget !== null && budget > 0 ? budget : null,
      priority,
    });
  }
  return out;
}

/** `/tmp` is a link to `/private/tmp`: the hub writes one, Topics may hold the other. A Windows server writes `\`. */
const normDir = (d: string): string => d.replace(/\\/g, '/').replace(/^\/private\/(tmp|var)\//, '/$1/').replace(/\/+$/, '');

/** The hub's folder (home written as `~`) is the project's folder, or lies inside it. */
function dirRelation(hubDir: string, projectPath: string): 'same' | 'inside' | null {
  const p = normDir(projectPath);
  let h = normDir(hubDir);
  if (h === '~' || h.startsWith('~/')) {
    // The home is the project's own: /Users/<name> or /home/<name> at the start of its path.
    const home = /^\/(?:Users|home)\/[^/]+/.exec(p)?.[0];
    if (!home) return null;
    h = home + h.slice(1);
  }
  if (h === p) return 'same';
  if (h.startsWith(p + '/')) return 'inside';
  return null;
}

const baseName = (p: string): string => normDir(p).split('/').pop() ?? '';

/** The hub's row for this Topics project, or null when none is recognised as it. */
export function matchHubProject(projects: readonly HubProject[], projectPath: string): HubProject | null {
  const same = projects.find((p) => p.dir !== null && dirRelation(p.dir, projectPath) === 'same');
  if (same) return same;
  const base = baseName(projectPath);
  return projects.find((p) => p.name === base && (p.dir === null || dirRelation(p.dir, projectPath) === 'inside')) ?? null;
}

/** Past your cap: the share of the week went over the budget you set. */
export function overBudget(p: HubProject): boolean {
  return p.budgetPct !== null && p.total > p.budgetPct;
}

/** A share of the week as the row says it: whole numbers, and «<1» for a trace. */
export function weekShare(total: number): string {
  if (total <= 0) return '0';
  if (total < 1) return '<1';
  return String(Math.round(total));
}

/** The budgets offered in the menu, in % of the week: none, a few steps, and the one in force if it is not a step. */
export function budgetChoices(current: number | null): Array<number | null> {
  const steps = [10, 25, 50];
  const values = current !== null && !steps.includes(current) ? [...steps, current].sort((a, b) => a - b) : steps;
  return [null, ...values];
}

/** The body of the hub's `project-settings` write: one change at a time, the name the hub keys it by. */
export function projectSettingsBody(name: string, change: { priority: HubPriority } | { budgetPct: number | null }): string {
  return JSON.stringify({ name, ...change });
}

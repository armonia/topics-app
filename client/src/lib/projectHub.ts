/**
 * THE PROJECT ROW'S HUB DATA (hub-smistamento, HUBBR-16): what the usage hub
 * knows of a project, read from the `projects` topic of the live store (the
 * hub's `/api/live`, trimmed by server/lib/hub-live.ts).
 *
 * A Topics project gets the hub's data only from the hub row that bears its
 * folder's name: that is how the hub names a project (a worktree is its repo,
 * the folder's last part is the name). The hub's `dir` is NOT the project's
 * folder: it is the folder of whichever agent ran there last (a board worktree,
 * a sibling repo, a cross-project session), so it moves from read to read and a
 * row matched by it would flicker or take another project's brake. Anything
 * the name does not pick shows nothing.
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
  hold: HubProjectHold;
  why: string;
  /** When the brake lets go, in ms; null when nobody knows. */
  waitUntil: number | null;
  /** Share of the week, in %, all providers together. */
  total: number;
  /** Share of the Claude week, in %: the figure the budget is measured on. */
  claude: number;
  /** Your cap in % of the Claude week (Codex and Muse count in other units); null when there is none. */
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
      hold: holdOf(p.state),
      why: str(p.why),
      waitUntil: num(p.waitUntil),
      total: num(p.total) ?? 0,
      claude: num(p.claude) ?? 0,
      budgetPct: budget !== null && budget > 0 ? budget : null,
      priority,
    });
  }
  return out;
}

/** The folder's last part, the name the hub gives it; a Windows server writes `\\`. */
const baseName = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';

/** The hub's row for this Topics project, or null when none is recognised as it. */
export function matchHubProject(projects: readonly HubProject[], projectPath: string): HubProject | null {
  const base = baseName(projectPath);
  if (!base) return null;
  return projects.find((p) => p.name === base) ?? null;
}

/**
 * At your cap: the Claude share of the week reached the budget you set. The
 * hub's brake fires at `claude >= budgetPct` (pacing.mjs `gate`), on Claude
 * alone: Codex and Muse are not summed in.
 */
export function overBudget(p: HubProject): boolean {
  return p.budgetPct !== null && p.claude >= p.budgetPct;
}

/** The share the row and the menu state: the Claude share where a budget is set (the budget's own figure), the whole week otherwise. */
export function shownShare(p: HubProject): number {
  return p.budgetPct !== null ? p.claude : p.total;
}

/**
 * Why the hub holds the project, as the row's own menu says it. The hub writes
 * its budget brake as «<name>: <claude>% of the Claude week, budget N%» (in
 * Italian, pacing.mjs `gate`): on the project's own row the name is noise,
 * and with a budget set the numbers repeat the budget line, so that reason
 * reads as `byBudget` with no words of its own.
 */
export function holdWhy(p: HubProject): { byBudget: boolean; why: string } {
  const prefix = `${p.name}: `;
  if (!p.why.startsWith(prefix)) return { byBudget: false, why: p.why };
  if (p.budgetPct !== null) return { byBudget: true, why: '' };
  return { byBudget: false, why: p.why.slice(prefix.length) };
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

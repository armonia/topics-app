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
  /** Share of the Codex and of the Muse week, in %. */
  codex: number;
  muse: number;
  /** What the project is, in the hub's words (a product's name, or the folder it is); '' when it has none. */
  what: string;
  /** The brake's reason in short words, with the restart time the hub wrote after « → »; '' when it has none. */
  brake: string;
  /** The last agent seen on the project, any provider, to the minute. */
  lastSeen: { at: number; provider: string } | null;
  /** The folder the project last worked in was temporary and is gone. */
  dirMissing: boolean;
  /** The project's live agents; null when none works there. */
  agents: HubAgents | null;
}

/** One live agent as the menu lists it. */
export interface HubAgent {
  provider: string;
  model: string;
  kind: string;
  /** 0 for a session, 1 for its sub-agent, 2 for a workflow's agent under it. */
  depth: number;
  title: string;
  startedAt: number | null;
  lastActivity: number | null;
  tokens: number;
  /** Its share of the week, in %. */
  pct: number;
  open: { url: string; via: string } | null;
}

export interface HubAgents {
  count: number;
  models: Array<{ provider: string; model: string; n: number }>;
  opus: number;
  opusMs: number;
  /** Tokens of the last hour, all the project's live agents together: the pace it burns at now. */
  hourTokens: number;
  list: HubAgent[];
}

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function agentOf(v: unknown): HubAgent | null {
  if (!isObject(v)) return null;
  const open = isObject(v.open) && typeof v.open.url === 'string' ? { url: v.open.url, via: str(v.open.via) } : null;
  return {
    provider: str(v.provider), model: str(v.model), kind: str(v.kind), depth: num(v.depth) ?? 0, title: str(v.title),
    startedAt: num(v.startedAt), lastActivity: num(v.lastActivity), tokens: num(v.tokens) ?? 0, pct: num(v.pct) ?? 0, open,
  };
}

function agentsOf(v: unknown): HubAgents | null {
  if (!isObject(v)) return null;
  const count = num(v.count) ?? 0;
  if (count <= 0) return null;
  const models = Array.isArray(v.models)
    ? v.models.flatMap((m) => (isObject(m) && (num(m.n) ?? 0) > 0 ? [{ provider: str(m.provider), model: str(m.model), n: num(m.n)! }] : []))
    : [];
  const list = Array.isArray(v.list) ? v.list.flatMap((g) => { const a = agentOf(g); return a ? [a] : []; }) : [];
  return { count, models, opus: num(v.opus) ?? 0, opusMs: num(v.opusMs) ?? 0, hourTokens: num(v.hourTokens) ?? 0, list };
}

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
      codex: num(p.codex) ?? 0,
      muse: num(p.muse) ?? 0,
      what: str(p.what),
      brake: str(p.brake),
      lastSeen: isObject(p.lastSeen) && num(p.lastSeen.at) !== null ? { at: num(p.lastSeen.at)!, provider: str(p.lastSeen.provider) } : null,
      dirMissing: p.dirMissing === true,
      agents: agentsOf(p.agents),
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
 * The accounts a quota gate waits on, from its raw reason
 * (`codex/work@x: ...; claude/home@y: ...` reads as Codex work, Claude home), as the
 * hub's page reads it when the hub wrote no short reason.
 */
function waitsFor(why: string): string[] {
  return why.split('; ').flatMap((seg) => {
    const m = /^(\w+)\/([^:]+):/.exec(seg);
    return m ? [`${PROVIDER_NAMES[m[1]!] ?? m[1]} ${m[2]!.split('@')[0]}`] : [];
  });
}

/** The provider names the hub's keys stand for. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', muse: 'Muse', jcode: 'jcode' };

/**
 * Why the hub holds the project, as the row's own menu says it. The hub writes
 * its budget brake as «<name>: <claude>% of the Claude week, budget N%» (in
 * Italian, pacing.mjs `gate`): on the project's own row the name is noise,
 * and with a budget set the numbers repeat the budget line, so that reason
 * reads as `byBudget` with no words of its own. Any other brake is said in the
 * hub's short words (`brake`, one reason per provider), without the
 * restart time it appends: the menu writes its own, with the day when it is
 * not today. A hub that wrote no short words leaves the raw gate reason: its
 * accounts come out as `waits` (provider and account), never the gate text.
 */
export function holdWhy(p: HubProject): { byBudget: boolean; why: string; waits: string[] } {
  const prefix = `${p.name}: `;
  if (p.why.startsWith(prefix) && p.budgetPct !== null) return { byBudget: true, why: '', waits: [] };
  const brake = p.brake.split(' \u2192 ')[0]!.trim();
  if (brake) return { byBudget: false, why: brake, waits: [] };
  if (p.why.startsWith(prefix)) return { byBudget: false, why: p.why.slice(prefix.length), waits: [] };
  const waits = waitsFor(p.why);
  return waits.length ? { byBudget: false, why: '', waits } : { byBudget: false, why: p.why, waits: [] };
}

/** Agents at work on the project: the hub's row says so before any brake, which holds new jobs, not running ones. */
export function working(p: HubProject): number {
  return p.agents?.count ?? 0;
}

/** Whether an agent is a Topics chat: the row's own loader already shows those. */
function inTopics(a: HubAgent): boolean {
  return agentOpen(a.open)?.kind === 'topic';
}

/** Agents at work outside Topics: the ones the row's own loader cannot show. */
export function workingOutside(p: HubProject): number {
  if (!p.agents) return 0;
  return Math.max(0, p.agents.count - p.agents.list.filter(inTopics).length);
}

/** When the brake lets go: the time alone today, with the day otherwise (a budget waits on the weekly reset, days away). */
export function restartParts(at: number, now: number, locale: string): { day: string | null; time: string } {
  const d = new Date(at);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return { day: sameDay ? null : d.toLocaleDateString(locale, { weekday: 'short' }).replace('.', ''), time };
}

/** The share of the week per provider, only the ones that spent something. */
export function providerShares(p: HubProject): Array<{ provider: 'claude' | 'codex' | 'muse'; pct: number }> {
  return ([['claude', p.claude], ['codex', p.codex], ['muse', p.muse]] as const)
    .filter(([, v]) => v > 0)
    .map(([provider, pct]) => ({ provider, pct }));
}

/** The agents' models in one line, most used first: `3 Opus · 2 Sonnet`. */
export function modelMix(a: HubAgents): string {
  return [...a.models].sort((x, y) => y.n - x.n).map((m) => `${m.n} ${m.model}`).join(' \u00b7 ');
}

/**
 * The hub's cost advice: Opus at work on a project that already took a tenth
 * of the Claude week, or Opus running for two hours or more (public/app.js
 * `agentsHtml`). Null when it does not apply.
 */
export function opusAdvice(p: HubProject): { n: number; ms: number } | null {
  const a = p.agents;
  if (!a || a.opus <= 0) return null;
  return p.claude >= 10 || a.opusMs >= 2 * 3_600_000 ? { n: a.opus, ms: a.opusMs } : null;
}

/**
 * Where an agent's open button leads: a Topics chat opens as a tab here (the hub
 * links it as `/tab/chat/<id>` on the app's own address), the desktop app's
 * `claude://` link and a web page open outside. Anything else is no link.
 */
export function agentOpen(open: HubAgent['open']): { kind: 'topic'; id: string } | { kind: 'external'; url: string } | null {
  if (!open) return null;
  const topic = /^https?:\/\/[^/]+\/tab\/chat\/([^/?#]+)/.exec(open.url);
  if (topic) return { kind: 'topic', id: decodeURIComponent(topic[1]!) };
  return /^(https?|claude):\/\//.test(open.url) ? { kind: 'external', url: open.url } : null;
}

/** Tokens as the menu says them: `786 k`, `1.2 M` in the reader's locale. */
export function shortTokens(n: number, locale: string): string {
  const f = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 1 });
  if (n >= 1e6) return `${f(n / 1e6)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(Math.round(n));
}

/** A share of the week as the row says it: whole numbers, and «<1» for a trace. */
export function weekShare(total: number): string {
  if (total <= 0) return '0';
  if (total < 1) return '<1';
  return String(Math.round(total));
}

/**
 * The budgets offered in the menu, in % of the Claude week: none, the tray's
 * steps (a hobby project gets 5), and the one in force if it is not a step.
 */
export function budgetChoices(current: number | null): Array<number | null> {
  const steps = [5, 10, 15, 20, 30];
  const values = current !== null && !steps.includes(current) ? [...steps, current].sort((a, b) => a - b) : steps;
  return [null, ...values];
}

/** The body of the hub's `project-settings` write: one change at a time, the name the hub keys it by. */
export function projectSettingsBody(name: string, change: { priority: HubPriority } | { budgetPct: number | null }): string {
  return JSON.stringify({ name, ...change });
}

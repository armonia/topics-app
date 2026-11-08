/**
 * AUTOMATIONS (hub-smistamento, HUBBR-14 and HUBBR-15): the hub's automations
 * read into the rows of the view that takes the place of the Cron panel.
 *
 * - the cards of the hub's model (`/api/hub/automations`), one per job, by
 *   system: Jarvis (its scheduled jobs and the health findings on them), Mac
 *   (launchd and the Claude desktop app), GitHub, PC and Workflow. Only the
 *   cards the hub judges (`needsYou`, `broken` and the groups in order), the
 *   ones its summary counts: the computer's own apps (`own`) and the tasks
 *   (`tasks`) sit in its `cards` index too, but outside the verdict, so a row
 *   of theirs would make «Decidi tu» disagree with the sidebar's number;
 * - the workflows of the last days, from the same model, as read-only rows;
 * - the Jarvis jobs as Topics reads them (`/api/cron/jobs`): the only ones
 *   with commands (run, on and off, remove), and the only source for the jobs
 *   switched off, which the hub leaves out of its model.
 *
 * Votes, notes and silences are written to the hub's feedback log and read
 * back with the model: `feedbackBody` builds the row the hub accepts.
 *
 * Pure reads: no fetch, no React. The view formats every word.
 */

import { asRecord, list, num, readHead, readUsage, str, usageTotal, type AutomationUsage, type AutomationsHead, type Raw } from './automationsHead';

export type AutomationSystem = 'jarvis' | 'mac' | 'github' | 'pc' | 'workflow';

export const AUTOMATION_SYSTEMS: readonly AutomationSystem[] = ['jarvis', 'mac', 'github', 'pc', 'workflow'];

/** The hub's levels: `te` waits on you, `rotto` is broken, `va` runs as it should. */
export type AutomationLevel = 'te' | 'rotto' | 'va';

export type RunOutcome = 'ok' | 'error' | 'skipped';

export type VoteValue = 'ok' | 'cambia' | 'indietro'; // allow-italian: the hub's vote values, compared by value

export interface AutomationFeedback {
  vote: { v: VoteValue; at: string | null; note: string | null } | null;
  /** The job changed after your vote: the vote speaks of what it was. */
  changedSinceVote: boolean;
  mute: { until: string | null; why: string | null } | null;
  /** Notes and reports nobody has closed yet. */
  open: number;
  notes: Array<{ at: string | null; note: string; kind: 'note' | 'complaint' }>;
}

/** The hub's areas: what an automation does for you, never the engine that runs it. */
export const AUTOMATION_AREAS = ['posta-avvisi', 'clienti', 'sviluppo-topics', 'jarvis-agenti', 'manutenzione', 'backup-sicurezza'] as const;
export type AutomationArea = (typeof AUTOMATION_AREAS)[number];

/** The old groups, for a card the purpose table does not know yet: the same guess as the hub's. */
const AREA_FROM_GROUP: Record<string, AutomationArea> = { arriva: 'posta-avvisi', dati: 'backup-sicurezza', quote: 'jarvis-agenti', macchine: 'manutenzione', prodotti: 'sviluppo-topics' };

/** One step of a job in short, as the hub sums its scheme up for the row. */
export interface FlowNode {
  kind: 'sources' | 'model' | 'step' | 'deliver';
  label: string;
  /** The brands that answer in a model step (claude, codex, muse), in queue order. */
  who: Array<{ name: string; brand: string | null }>;
  brand: string | null;
}

export interface AutomationFlow {
  steps: number;
  ai: boolean;
  nodes: FlowNode[];
}

export interface WorkflowRun {
  runId: string;
  at: number;
  outcome: RunOutcome | 'running';
  durationMs: number | null;
  agents: number | null;
}

export interface AutomationRow {
  key: string;
  system: AutomationSystem;
  title: string;
  level: AutomationLevel;
  /** The hub's reason, in its words. */
  reason: string | null;
  since: number | null;
  /** The hub's own wording of the schedule, already in Italian. */
  when: string | null;
  next: number | null;
  /** What it does for you, in the hub's words. */
  what: string | null;
  last: { at: number | null; outcome: RunOutcome | null; exit: number | null; error: string | null };
  /** The runs of the last day, newest first, as the hub keeps them. */
  day: Array<{ at: number; outcome: RunOutcome }>;
  runsToday: number;
  feedback: AutomationFeedback;
  /** The fingerprint the hub stamps on a vote, to tell when a job changed after it. */
  fp: string | null;
  /** The Jarvis job behind the row: the only rows with commands. */
  jobId: string | null;
  /** As jarvis-channels says; null where Topics has no word on it. */
  enabled: boolean | null;
  /** A row the hub keeps a feedback log for (not a workflow). */
  votable: boolean;
  workflowRuns: WorkflowRun[];
  /** What it does for you, by the hub's areas; null for a row with no card (workflow, switched-off job). */
  area: AutomationArea | null;
  /** What you could lose while it stays broken, from the hub's purpose table. */
  ifBroken: string | null;
  /** A row in order with a remark: recovering after errors, coming and going. */
  warn: string | null;
  /** Closed runs, newest first, up to 20: the source of «failed the last N times» and the ticks. */
  history: Array<{ at: number; outcome: RunOutcome }>;
  nextApprox: boolean;
  usage: AutomationUsage | null;
  /** Whether the last message reached you. */
  delivered: 'delivered' | 'failed' | null;
  /** The outside proof of a run («backup: a commit at 3:12»). */
  proof: { ok: boolean | null; words: string } | null;
  who: string | null;
  means: string | null;
  tech: { schedule: string | null; command: string | null; prompt: string | null; url: string | null };
  /** The providers of the sources fused into this row; one for most rows. */
  sources: string[];
  /** The project it belongs to, with the hub's icon path. */
  project: { name: string; icon: string | null } | null;
  /** Where it runs, as the hub labels it («Mac (launchd)», «GitHub Actions»). */
  where: string | null;
  flow: AutomationFlow | null;
  /** A workflow step waiting for your ok: not something «Risolvi tu» can fix. */
  gate: boolean;
  /** The computer's own apps: shown, never counted among the problems. */
  own: boolean;
}

export interface AutomationsModel extends AutomationsHead {
  rows: AutomationRow[];
  /** The computer's own apps (Mac, PC, Topics…), outside the verdict and «Decidi tu». */
  own: AutomationRow[];
  checkedAt: number | null;
  runsToday: number;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { kind: string; everyMs?: number; expr?: string; at?: string } | null;
  nextRunAt: number | null;
}

const EMPTY_FEEDBACK: AutomationFeedback = { vote: null, changedSinceVote: false, mute: null, open: 0, notes: [] };

/** A row with nothing known but its key, system and title: every reader starts from here. */
function blankRow(key: string, system: AutomationSystem, title: string): AutomationRow {
  return {
    key, system, title, level: 'va', reason: null, since: null, when: null, next: null, what: null,
    last: { at: null, outcome: null, exit: null, error: null }, day: [], runsToday: 0, feedback: EMPTY_FEEDBACK, fp: null,
    jobId: null, enabled: null, votable: true, workflowRuns: [], area: null, ifBroken: null, warn: null, history: [],
    nextApprox: false, usage: null, delivered: null, proof: null, who: null, means: null,
    tech: { schedule: null, command: null, prompt: null, url: null }, sources: [], project: null, where: null, flow: null, gate: false, own: false,
  };
}

function outcome(v: unknown): RunOutcome | null {
  return v === 'ok' || v === 'error' || v === 'skipped' ? v : null;
}

/** The hub provider of Jarvis' scheduled jobs: the only cards with commands. */
export function isJarvisJobProvider(provider: unknown): boolean {
  return provider === 'jarvis';
}

/** The system a hub provider belongs to; null for one this view does not list. */
export function systemOf(provider: unknown): AutomationSystem | null {
  if (isJarvisJobProvider(provider)) return 'jarvis';
  switch (provider) {
    case 'health':
      return 'jarvis';
    case 'launchd':
    case 'desktop':
      return 'mac';
    case 'github':
      return 'github';
    case 'pc':
      return 'pc';
    case 'workflow':
    case 'workflows':
    case 'lobster':
      return 'workflow';
    case 'findings':
      return 'jarvis';
    default:
      return null;
  }
}

/** The Jarvis job id of a hub key (`cron:<id>`), or null. */
export function cronJobId(key: string): string | null {
  const m = /^cron:([\w-]+)$/.exec(key);
  return m ? m[1]! : null;
}

function readFeedback(raw: unknown): AutomationFeedback {
  const f = asRecord(raw);
  if (!f) return EMPTY_FEEDBACK;
  const v = asRecord(f.vote);
  const vv = v?.v;
  const vote = v && (vv === 'ok' || vv === 'cambia' || vv === 'indietro') ? { v: vv as VoteValue, at: str(v.at), note: str(v.note) } : null; // allow-italian: the hub's vote values
  const m = asRecord(f.mute);
  const mute = m ? { until: str(m.until), why: str(m.why) } : null;
  const notes = (Array.isArray(f.notes) ? f.notes : []).flatMap((n) => {
    const o = asRecord(n);
    const note = o && str(o.note);
    return o && note ? [{ at: str(o.at), note, kind: o.kind === 'complaint' ? ('complaint' as const) : ('note' as const) }] : [];
  });
  return { vote, changedSinceVote: f.changedSinceVote === true, mute, open: num(f.open) ?? 0, notes };
}

/**
 * «If it breaks», said to you: the hub's purpose table writes it about you in
 * the third person, and the line under a broken row speaks to you.
 */
export function ifBrokenToYou(text: string): string {
  return text.replace(/^Attilio potrebbe\s+/, 'potresti '); // allow-italian: the hub's own sentence, turned to the second person
}

/** A gate of a workflow: the hub's reason names the step waiting for your ok, in guillemets. */
export function isGateReason(level: AutomationLevel, reason: string | null): boolean {
  return level === 'te' && /passo «[^»]+»/.test(reason ?? '');
}

/** Only a web address becomes a link: anything else in the hub's data stays text. */
function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

const BRANDS = new Set(['claude', 'codex', 'muse', 'whatsapp', 'discord', 'telegram']);

function readFlow(v: unknown): AutomationFlow | null {
  const f = asRecord(v);
  if (!f) return null;
  const nodes = list(f.nodes).flatMap((n): FlowNode[] => {
    const o = asRecord(n);
    const kind = o?.kind;
    const label = o && str(o.label);
    if (!o || !label || (kind !== 'sources' && kind !== 'model' && kind !== 'step' && kind !== 'deliver')) return [];
    const who = list(o.who).flatMap((w) => {
      const x = asRecord(w);
      const name = x && str(x.name);
      return x && name ? [{ name, brand: typeof x.brand === 'string' && BRANDS.has(x.brand) ? x.brand : null }] : [];
    });
    return [{ kind, label, who, brand: typeof o.brand === 'string' && BRANDS.has(o.brand) ? o.brand : null }];
  });
  return nodes.length ? { steps: num(f.steps) ?? nodes.length, ai: f.ai === true, nodes } : null;
}

function readHistory(v: unknown): AutomationRow['history'] {
  return list(v).flatMap((h) => {
    const o = asRecord(h);
    const at = o && num(o.at);
    const oc = o && outcome(o.outcome);
    return at !== null && oc ? [{ at, outcome: oc }] : [];
  }).sort((a, b) => b.at - a.at).slice(0, 20);
}

function readArea(purpose: Record<string, unknown>, group: unknown): AutomationArea | null {
  const a = purpose.area;
  if (typeof a === 'string' && (AUTOMATION_AREAS as readonly string[]).includes(a)) return a as AutomationArea;
  return typeof group === 'string' ? AREA_FROM_GROUP[group] ?? 'manutenzione' : 'manutenzione';
}

function readCard(raw: unknown, own = false): AutomationRow | null {
  const c = asRecord(raw);
  const key = c && str(c.key);
  if (!c || !key) return null;
  const level = c.level === 'te' || c.level === 'rotto' || c.level === 'va' ? c.level : null;
  const system = systemOf(c.provider);
  // The hidden level (switched off, silenced) stays out, as on the hub's page.
  if (!level || !system) return null;
  const last = asRecord(c.last) ?? {};
  const tech = asRecord(c.tech) ?? {};
  const purpose = asRecord(c.purpose) ?? {};
  const day = list(c.day).flatMap((d) => {
    const at = Array.isArray(d) ? num(d[0]) : null;
    const o = Array.isArray(d) ? outcome(d[1]) : null;
    return at !== null && o ? [{ at, outcome: o }] : [];
  });
  const proof = asRecord(c.proof);
  const proofWords = proof && str(proof.words);
  const project = asRecord(c.project);
  const projectName = project && str(project.name);
  const reason = str(c.reason);
  const sources = list(c.sources).flatMap((x) => {
    const p = str(asRecord(x)?.provider);
    return p ? [p] : [];
  });
  return {
    ...blankRow(key, system, str(c.title) ?? key),
    level,
    reason,
    since: num(c.since),
    when: str(c.when),
    next: num(c.next),
    what: str(purpose.cosaFaPerTe) ?? str(c.cosa),
    last: { at: num(last.at), outcome: outcome(last.outcome), exit: num(tech.exit), error: str(last.error) },
    day,
    runsToday: num(c.runsToday) ?? 0,
    feedback: readFeedback(c.feedback),
    fp: str(c.fp),
    jobId: isJarvisJobProvider(c.provider) ? cronJobId(key) : null,
    area: readArea(purpose, c.group),
    ifBroken: str(purpose.seSiRompe),
    warn: str(c.warn),
    history: readHistory(c.history),
    nextApprox: c.nextApprox === true,
    usage: readUsage(c.usage),
    delivered: last.delivered === 'delivered' || last.delivered === 'failed' ? last.delivered : null,
    proof: proofWords ? { ok: typeof proof.ok === 'boolean' ? proof.ok : null, words: proofWords } : null,
    who: str(c.who),
    means: str(c.means),
    tech: { schedule: str(tech.schedule), command: str(tech.command), prompt: str(tech.prompt), url: httpUrl(tech.url) },
    sources,
    project: projectName ? { name: projectName, icon: str(project.icon) } : null,
    where: str(asRecord(c.where)?.label),
    flow: readFlow(c.flow),
    gate: isGateReason(level, reason),
    own,
  };
}

/** «audit-dipendenze» reads «Audit dipendenze». */
export function workflowTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

function readWorkflow(raw: unknown): AutomationRow | null {
  const w = asRecord(raw);
  const name = w && str(w.name);
  if (!w || !name) return null;
  const runs = (Array.isArray(w.runs) ? w.runs : []).flatMap((r): WorkflowRun[] => {
    const o = asRecord(r);
    const at = o && num(o.at);
    const runId = o && str(o.runId);
    if (!o || at === null || !runId) return [];
    const oc = o.outcome === 'running' ? 'running' : outcome(o.outcome) ?? 'error';
    return [{ runId, at, outcome: oc, durationMs: num(o.durationMs), agents: num(o.agents) }];
  }).sort((a, b) => b.at - a.at);
  const lastRun = runs[0] ?? null;
  return {
    ...blankRow(`workflow:${name}`, 'workflow', workflowTitle(name)),
    last: { at: lastRun?.at ?? null, outcome: lastRun && lastRun.outcome !== 'running' ? lastRun.outcome : null, exit: null, error: null },
    day: runs.flatMap((r) => (r.outcome === 'running' ? [] : [{ at: r.at, outcome: r.outcome }])),
    history: runs.flatMap((r) => (r.outcome === 'running' ? [] : [{ at: r.at, outcome: r.outcome }])).slice(0, 20),
    votable: false,
    workflowRuns: runs,
  };
}

/** The cards the hub judges, the ones its summary counts: to decide, broken, then the groups in order. */
function judgedCards(m: Raw): unknown[] {
  return [...list(m.needsYou), ...list(m.broken), ...list(m.groups).flatMap((g) => list(asRecord(g)?.cards))];
}

/** The hub's model as rows, or null when the answer is not the hub's. */
export function readAutomations(raw: unknown): AutomationsModel | null {
  const m = asRecord(raw);
  if (!m || !asRecord(m.cards)) return null;
  const rows = judgedCards(m).flatMap((c) => {
    const r = readCard(c);
    return r ? [r] : [];
  });
  const byName = asRecord(m.workflows)?.byName;
  for (const w of list(byName)) {
    const r = readWorkflow(w);
    if (r) rows.push(r);
  }
  const own = list(m.own).flatMap((c) => {
    const r = readCard(c, true);
    return r ? [r] : [];
  });
  const verdict = asRecord(m.verdict);
  return {
    ...readHead(m), rows, own, checkedAt: num(m.checkedAt),
    runsToday: num(verdict?.runsToday) ?? rows.reduce((s, r) => s + r.runsToday, 0),
  };
}

/** The Jarvis jobs as `/api/cron/jobs` lists them. */
export function readCronJobs(raw: unknown): CronJob[] | null {
  const list = asRecord(raw)?.jobs;
  if (!Array.isArray(list)) return null;
  return list.flatMap((j) => {
    const o = asRecord(j);
    const id = o && str(o.id);
    if (!o || !id) return [];
    const s = asRecord(o.schedule);
    const next = str(o.nextRunAt);
    return [{
      id,
      name: str(o.name) ?? id,
      enabled: o.enabled !== false,
      schedule: s && typeof s.kind === 'string' ? { kind: s.kind, everyMs: num(s.everyMs) ?? undefined, expr: str(s.expr) ?? undefined, at: str(s.at) ?? undefined } : null,
      nextRunAt: next ? Date.parse(next) : null,
    }];
  });
}

/**
 * The hub's rows with jarvis-channels' word on each Jarvis job: on or off, and
 * the jobs switched off (the hub leaves them out) as rows of their own, so
 * they can be switched back on from here. `describe` words the schedule of
 * those rows, which the hub does not describe.
 */
export function withCronJobs(rows: AutomationRow[], jobs: CronJob[] | null, describe?: (job: CronJob) => string | null): AutomationRow[] {
  if (!jobs) return rows;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const seen = new Set<string>();
  const out = rows.map((r) => {
    const j = r.jobId ? byId.get(r.jobId) : undefined;
    if (!j) return r;
    seen.add(j.id);
    return { ...r, enabled: j.enabled };
  });
  for (const j of jobs) {
    if (seen.has(j.id)) continue;
    out.push({ ...blankRow(`cron:${j.id}`, 'jarvis', j.name), when: describe?.(j) ?? null, next: j.enabled ? j.nextRunAt : null, jobId: j.id, enabled: j.enabled });
  }
  return out;
}

/** The schedule of a job the hub does not describe, as parts the view words. */
export type ScheduleParts =
  | { kind: 'minutes' | 'hours' | 'days'; n: number }
  | { kind: 'expr'; expr: string }
  | { kind: 'at'; at: number };

export function scheduleParts(job: CronJob | undefined): ScheduleParts | null {
  const s = job?.schedule;
  if (!s) return null;
  if (s.kind === 'every' && s.everyMs) {
    const min = Math.round(s.everyMs / 60_000);
    if (min % 1440 === 0) return { kind: 'days', n: min / 1440 };
    if (min % 60 === 0) return { kind: 'hours', n: min / 60 };
    return { kind: 'minutes', n: Math.max(1, min) };
  }
  if (s.kind === 'cron' && s.expr) return { kind: 'expr', expr: s.expr };
  if (s.kind === 'at' && s.at) {
    const at = Date.parse(s.at);
    return Number.isNaN(at) ? null : { kind: 'at', at };
  }
  return null;
}

/**
 * What waits on you, oldest first: the broken ones and the ones to decide.
 * A workflow step waiting for your ok is not one: no agent can fix it, and
 * the ones that are yours reach the bell (`gatesWaiting`).
 */
export function toDecide(rows: AutomationRow[]): AutomationRow[] {
  return rows
    .filter((r) => r.level !== 'va' && !r.gate)
    .sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.title.localeCompare(b.title, 'it'));
}

/** The workflow steps waiting for an ok, left out of «Decidi tu». */
export function gatesWaiting(rows: AutomationRow[]): number {
  return rows.filter((r) => r.gate).length;
}

/** The newest runs failed in a row, newest first: «failed the last N times» when more than one. */
export function failStreak(row: Pick<AutomationRow, 'history'>): number {
  let n = 0;
  for (const h of row.history) {
    if (h.outcome !== 'error') break;
    n++;
  }
  return n;
}

/** The view's status filter: all, the ones in order, the problems. */
export type StatusFilter = 'all' | 'ok' | 'problems';

export function isProblem(row: AutomationRow): boolean {
  return row.level !== 'va';
}

export function matchesStatus(row: AutomationRow, f: StatusFilter): boolean {
  return f === 'all' || (f === 'problems' ? isProblem(row) : !isProblem(row));
}

export interface SystemCount {
  system: AutomationSystem;
  total: number;
  /** Broken or waiting on you. */
  toFix: number;
}

export function systemCounts(rows: AutomationRow[]): SystemCount[] {
  return AUTOMATION_SYSTEMS.map((system) => {
    const mine = rows.filter((r) => r.system === system);
    return { system, total: mine.length, toFix: mine.filter((r) => r.level !== 'va').length };
  }).filter((c) => c.total > 0);
}

/** Rows in the view's order: what waits on you first, the costliest next, the switched-off ones last, then by title. */
export function sortRows(rows: AutomationRow[]): AutomationRow[] {
  const rank = (r: AutomationRow) => (r.level === 'va' ? (r.enabled === false ? 2 : 1) : 0);
  return [...rows].sort((a, b) => rank(a) - rank(b) || usageTotal(b.usage) - usageTotal(a.usage) || a.title.localeCompare(b.title, 'it'));
}

/** A system's rows, in the view's order. */
export function systemRows(rows: AutomationRow[], system: AutomationSystem): AutomationRow[] {
  return sortRows(rows.filter((r) => r.system === system));
}

export interface AreaGroup {
  area: AutomationArea;
  rows: AutomationRow[];
  ok: number;
  decide: number;
  broken: number;
}

/** The rows by what they do for you, as the hub groups them: the areas with a problem first, then the biggest. */
export function areaGroups(rows: AutomationRow[]): AreaGroup[] {
  return AUTOMATION_AREAS.map((area) => {
    const mine = sortRows(rows.filter((r) => (r.area ?? 'manutenzione') === area));
    const decide = mine.filter((r) => r.level === 'te').length;
    const broken = mine.filter((r) => r.level === 'rotto').length;
    return { area, rows: mine, ok: mine.length - decide - broken, decide, broken };
  }).filter((g) => g.rows.length > 0)
    .sort((a, b) => Number(b.decide + b.broken > 0) - Number(a.decide + a.broken > 0) || b.rows.length - a.rows.length);
}

/**
 * The search: by name, by what it does for you, by who runs it, by what it
 * writes to you and by its system, whose name in the person's language the
 * caller passes.
 */
export function matchesQuery(row: AutomationRow, query: string, systemName = ''): boolean {
  const q = query.trim().toLocaleLowerCase('it');
  if (!q) return true;
  return [row.title, row.what, row.who, row.means, row.where, systemName].some((t) => (t ?? '').toLocaleLowerCase('it').includes(q));
}

export interface Verdict {
  toFix: number;
  decide: number;
  broken: number;
  ok: number;
  total: number;
  next: { title: string; at: number } | null;
}

export function verdictOf(rows: AutomationRow[], now: number): Verdict {
  const decide = rows.filter((r) => r.level === 'te').length;
  const broken = rows.filter((r) => r.level === 'rotto').length;
  let next: Verdict['next'] = null;
  for (const r of rows) if (r.next !== null && r.next > now && r.enabled !== false && (!next || r.next < next.at)) next = { title: r.title, at: r.next };
  return { toFix: decide + broken, decide, broken, ok: rows.length - decide - broken, total: rows.length, next };
}

/** «N da sistemare» of the sidebar row, from the hub's summary; null when it is not one. */
export function toFixCount(summary: unknown): number | null {
  const s = asRecord(summary);
  const a = s ? num(s.needsYou) : null;
  const b = s ? num(s.broken) : null;
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

/** A past hour by its worst run, an hour ahead empty or holding the next run. */
export type StripCell = RunOutcome | 'none' | 'ahead' | 'next';

/** Hours of the strip behind now (the hour now included) and ahead of it, as the hub draws it: 22 + 2. */
export const STRIP_BACK = 22;
export const STRIP_AHEAD = 2;

export interface Strip {
  cells: StripCell[];
  /** Index of the hour now: the cells after it are ahead. */
  nowIndex: number;
  /** Runs in the hours behind, and how many of them failed: the strip's words. */
  runs: number;
  failed: number;
}

/** The 24-hour strip: 22 hours behind, one cell per hour with its worst run, and 2 ahead with the next run. */
export function dayStrip(day: AutomationRow['day'], now: number, next: number | null = null): Strip {
  const cells: StripCell[] = Array.from({ length: STRIP_BACK + STRIP_AHEAD }, (_, i) => (i < STRIP_BACK ? 'none' : 'ahead'));
  const weight: Record<StripCell, number> = { none: 0, ahead: 0, next: 0, ok: 1, skipped: 2, error: 3 };
  const nowIndex = STRIP_BACK - 1;
  let runs = 0;
  let failed = 0;
  for (const d of day) {
    const ago = Math.floor((now - d.at) / 3_600_000);
    if (ago < 0 || ago >= STRIP_BACK) continue;
    runs++;
    if (d.outcome === 'error') failed++;
    const i = nowIndex - ago;
    if (weight[d.outcome] > weight[cells[i]!]) cells[i] = d.outcome;
  }
  if (next !== null && next > now) {
    const ahead = Math.floor((next - now) / 3_600_000);
    if (ahead < STRIP_AHEAD) cells[nowIndex + 1 + ahead] = 'next';
  }
  return { cells, nowIndex, runs, failed };
}

/** The runs of today and how many went well, for the detail's heading. */
export function todayRuns(day: AutomationRow['day'], startOfToday: number): { total: number; ok: number } {
  const today = day.filter((d) => d.at >= startOfToday);
  return { total: today.length, ok: today.filter((d) => d.outcome === 'ok').length };
}

/** The commands a row carries: only a Jarvis job jarvis-channels lists. */
export function hasCommands(row: AutomationRow): boolean {
  return row.jobId !== null && row.enabled !== null;
}

export type FeedbackAction = 'ok' | 'cambia' | 'nota' | 'segnala' | 'muta';

/** The actions that need words: the hub refuses them without. */
export const FEEDBACK_NEEDS_TEXT: ReadonlySet<FeedbackAction> = new Set(['cambia', 'nota', 'segnala', 'muta']);

/**
 * The row the hub's `POST /api/feedback` accepts for an action, or null when
 * a required text is missing. `muteDays` null silences for good.
 */
export function feedbackBody(action: FeedbackAction, row: Pick<AutomationRow, 'key' | 'fp'>, text: string, now: number, muteDays: number | null = 7): Record<string, unknown> | null {
  const note = text.trim();
  const base = { key: row.key, ...(row.fp ? { fp: row.fp } : {}) };
  if (FEEDBACK_NEEDS_TEXT.has(action) && !note) return null;
  switch (action) {
    case 'ok':
      return { kind: 'vote', ...base, v: 'ok' };
    case 'cambia':
      return { kind: 'vote', ...base, v: 'cambia', note };
    case 'nota':
      return { kind: 'note', ...base, note };
    case 'segnala':
      return { kind: 'complaint', ...base, note };
    case 'muta':
      return { kind: 'mute', ...base, why: note, until: muteDays === null ? null : new Date(now + muteDays * 86_400_000).toISOString() };
  }
}

/** The row that takes a feedback row back, by the id the hub gave it (the undo button). */
export function undoBody(ref: string): Record<string, unknown> {
  return { kind: 'undo', ref };
}

/** The id of the row the hub wrote, from its answer to a feedback post. */
export function feedbackRowId(answer: unknown): string | null {
  return str(asRecord(asRecord(answer)?.row)?.id);
}

/** The command of a job, as the Topics route takes it. */
export type JobCommand = { kind: 'run' } | { kind: 'enable'; on: boolean } | { kind: 'remove' };

export function jobRequest(jobId: string, c: JobCommand): { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown> } {
  const path = `/api/cron/jobs/${encodeURIComponent(jobId)}`;
  if (c.kind === 'run') return { path: `${path}/run`, method: 'POST' };
  if (c.kind === 'enable') return { path, method: 'PATCH', body: { enabled: c.on } };
  return { path, method: 'DELETE' };
}

/** Why a command was refused, for the view to word: the scheduler's English stays out. */
export function refusalOf(status: number): 'gateway' | 'notRun' | 'refused' {
  if (status === 409) return 'notRun';
  if (status === 502 || status === 503 || status === 504) return 'gateway';
  return 'refused';
}

/** The keys a «Risolvi tu» agent is already on, from the hub's queue. */
export function fixingKeys(queue: unknown): Set<string> {
  const items = asRecord(queue)?.items;
  const out = new Set<string>();
  for (const i of Array.isArray(items) ? items : []) {
    const o = asRecord(i);
    const ref = o && str(o.ref);
    if (o && ref && (o.status === 'queued' || o.status === 'running')) out.add(ref);
  }
  return out;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala

/**
 * AUTOMATIONS (hub-smistamento, HUBBR-14 and HUBBR-15): the hub's automations
 * read into the rows of the view that takes the place of the Cron panel.
 *
 * - the cards of the hub's model (`/api/hub/automations`), one per job, by
 *   system: Jarvis (the OpenClaw jobs and the health findings on them), Mac
 *   (launchd and the Claude desktop app), GitHub, PC and Workflow; the hidden
 *   ones (switched off, silenced) stay out, as on the hub's page;
 * - the workflows of the last days, from the same model, as read-only rows;
 * - the OpenClaw jobs as Topics reads them (`/api/cron/jobs`): the only ones
 *   with commands (run, on and off, remove), and the only source for the jobs
 *   switched off, which the hub leaves out of its model.
 *
 * Votes, notes and silences are written to the hub's feedback log and read
 * back with the model: `feedbackBody` builds the row the hub accepts.
 *
 * Pure reads: no fetch, no React. The view formats every word.
 */

export type AutomationSystem = 'jarvis' | 'mac' | 'github' | 'pc' | 'workflow';

export const AUTOMATION_SYSTEMS: readonly AutomationSystem[] = ['jarvis', 'mac', 'github', 'pc', 'workflow'];

/** The hub's levels: `te` waits on you, `rotto` is broken, `va` runs as it should. */
export type AutomationLevel = 'te' | 'rotto' | 'va';

export type RunOutcome = 'ok' | 'error' | 'skipped';

export type VoteValue = 'ok' | 'cambia' | 'indietro'; // allow-italian: the hub's vote values, compared by value

export interface AutomationFeedback {
  vote: { v: VoteValue; at: string | null; note: string | null } | null;
  mute: { until: string | null; why: string | null } | null;
  notes: Array<{ at: string | null; note: string; kind: 'note' | 'complaint' }>;
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
  /** The OpenClaw job behind the row: the only rows with commands. */
  jobId: string | null;
  /** As the OpenClaw gateway says; null where Topics has no word on it. */
  enabled: boolean | null;
  /** A row the hub keeps a feedback log for (not a workflow). */
  votable: boolean;
  workflowRuns: WorkflowRun[];
}

export interface AutomationsModel {
  rows: AutomationRow[];
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

const EMPTY_FEEDBACK: AutomationFeedback = { vote: null, mute: null, notes: [] };

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function outcome(v: unknown): RunOutcome | null {
  return v === 'ok' || v === 'error' || v === 'skipped' ? v : null;
}

/** The system a hub provider belongs to; null for one this view does not list. */
export function systemOf(provider: unknown): AutomationSystem | null {
  switch (provider) {
    case 'openclaw':
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
    case 'lobster':
      return 'workflow';
    default:
      return null;
  }
}

/** The OpenClaw job id of a hub key (`cron:<id>`), or null. */
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
  return { vote, mute, notes };
}

function readCard(raw: unknown): AutomationRow | null {
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
  const day = (Array.isArray(c.day) ? c.day : []).flatMap((d) => {
    const at = Array.isArray(d) ? num(d[0]) : null;
    const o = Array.isArray(d) ? outcome(d[1]) : null;
    return at !== null && o ? [{ at, outcome: o }] : [];
  });
  const jobId = c.provider === 'openclaw' ? cronJobId(key) : null;
  return {
    key,
    system,
    title: str(c.title) ?? key,
    level,
    reason: str(c.reason),
    since: num(c.since),
    when: str(c.when),
    next: num(c.next),
    what: str(purpose.cosaFaPerTe) ?? str(c.cosa),
    last: { at: num(last.at), outcome: outcome(last.outcome), exit: num(tech.exit), error: str(last.error) },
    day,
    runsToday: num(c.runsToday) ?? 0,
    feedback: readFeedback(c.feedback),
    fp: str(c.fp),
    jobId,
    enabled: null,
    votable: true,
    workflowRuns: [],
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
    key: `workflow:${name}`,
    system: 'workflow',
    title: workflowTitle(name),
    level: 'va',
    reason: null,
    since: null,
    when: null,
    next: null,
    what: null,
    last: { at: lastRun?.at ?? null, outcome: lastRun && lastRun.outcome !== 'running' ? lastRun.outcome : null, exit: null, error: null },
    day: runs.flatMap((r) => (r.outcome === 'running' ? [] : [{ at: r.at, outcome: r.outcome }])),
    runsToday: 0,
    feedback: EMPTY_FEEDBACK,
    fp: null,
    jobId: null,
    enabled: null,
    votable: false,
    workflowRuns: runs,
  };
}

/** The hub's model as rows, or null when the answer is not the hub's. */
export function readAutomations(raw: unknown): AutomationsModel | null {
  const m = asRecord(raw);
  const cards = m && asRecord(m.cards);
  if (!m || !cards) return null;
  const rows = Object.values(cards).flatMap((c) => {
    const r = readCard(c);
    return r ? [r] : [];
  });
  const byName = asRecord(m.workflows)?.byName;
  for (const w of Array.isArray(byName) ? byName : []) {
    const r = readWorkflow(w);
    if (r) rows.push(r);
  }
  const verdict = asRecord(m.verdict);
  return { rows, checkedAt: num(m.checkedAt), runsToday: num(verdict?.runsToday) ?? rows.reduce((s, r) => s + r.runsToday, 0) };
}

/** The OpenClaw jobs as `/api/cron/jobs` lists them. */
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
 * The hub's rows with the gateway's word on each OpenClaw job: on or off, and
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
    out.push({
      key: `cron:${j.id}`, system: 'jarvis', title: j.name, level: 'va', reason: null, since: null, when: describe?.(j) ?? null,
      next: j.enabled ? j.nextRunAt : null, what: null, last: { at: null, outcome: null, exit: null, error: null },
      day: [], runsToday: 0, feedback: EMPTY_FEEDBACK, fp: null, jobId: j.id, enabled: j.enabled, votable: true, workflowRuns: [],
    });
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

/** What waits on you, oldest first: the broken ones and the ones to decide. */
export function toDecide(rows: AutomationRow[]): AutomationRow[] {
  return rows
    .filter((r) => r.level !== 'va')
    .sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.title.localeCompare(b.title, 'it'));
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

/** A system's rows: what waits on you first, then the switched-off ones last, by title. */
export function systemRows(rows: AutomationRow[], system: AutomationSystem): AutomationRow[] {
  const rank = (r: AutomationRow) => (r.level === 'va' ? (r.enabled === false ? 2 : 1) : 0);
  return rows.filter((r) => r.system === system).sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'it'));
}

export function matchesQuery(row: AutomationRow, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('it');
  return !q || row.title.toLocaleLowerCase('it').includes(q) || (row.what ?? '').toLocaleLowerCase('it').includes(q);
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

export type StripCell = RunOutcome | 'none';

/** The last 24 hours, one cell per hour, the last one the hour now: the worst run of each. */
export function dayStrip(day: AutomationRow['day'], now: number): StripCell[] {
  const cells: StripCell[] = Array.from({ length: 24 }, () => 'none');
  const weight: Record<StripCell, number> = { none: 0, ok: 1, skipped: 2, error: 3 };
  for (const d of day) {
    const ago = Math.floor((now - d.at) / 3_600_000);
    if (ago < 0 || ago > 23) continue;
    const i = 23 - ago;
    if (weight[d.outcome] > weight[cells[i]!]) cells[i] = d.outcome;
  }
  return cells;
}

/** The runs of today and how many went well, for the detail's heading. */
export function todayRuns(day: AutomationRow['day'], startOfToday: number): { total: number; ok: number } {
  const today = day.filter((d) => d.at >= startOfToday);
  return { total: today.length, ok: today.filter((d) => d.outcome === 'ok').length };
}

/** The commands a row carries: only an OpenClaw job the gateway lists. */
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

/** The command of a job, as the Topics route takes it. */
export type JobCommand = { kind: 'run' } | { kind: 'enable'; on: boolean } | { kind: 'remove' };

export function jobRequest(jobId: string, c: JobCommand): { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown> } {
  const path = `/api/cron/jobs/${encodeURIComponent(jobId)}`;
  if (c.kind === 'run') return { path: `${path}/run`, method: 'POST' };
  if (c.kind === 'enable') return { path, method: 'PATCH', body: { enabled: c.on } };
  return { path, method: 'DELETE' };
}

/** Why a command was refused, for the view to word: the gateway's English stays out. */
export function refusalOf(status: number): 'gateway' | 'notRun' | 'refused' {
  if (status === 409) return 'notRun';
  if (status === 502 || status === 503 || status === 504) return 'gateway';
  return 'refused';
}

export interface CronRun {
  at: number;
  ms: number | null;
  outcome: RunOutcome | null;
  /** First line of what it produced or of its error. */
  text: string | null;
}

function firstLine(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line || null;
}

/** The runs of an OpenClaw job, as the hub's `automations/runs` answers them. */
export function readCronRuns(raw: unknown): CronRun[] | null {
  const list = asRecord(raw)?.runs;
  if (!Array.isArray(list)) return null;
  return list.flatMap((r) => {
    const o = asRecord(r);
    const at = o && num(o.at);
    if (!o || at === null) return [];
    const oc = outcome(o.outcome);
    return [{ at, ms: num(o.ms), outcome: oc, text: oc === 'error' ? firstLine(o.error) ?? firstLine(o.text) : firstLine(o.text) }];
  });
}

/** The hub's estimate of a workflow run's cost: agents and share of the week. */
export function readRunCost(raw: unknown): { agents: number; weekPct: number | null } | null {
  const o = asRecord(raw);
  if (!o || o.ok !== true) return null;
  return { agents: num(o.agents) ?? 0, weekPct: num(o.weekPct) };
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

export type CalendarKind = 'promemoria' | 'compito';

export interface CalendarEntry {
  key: string;
  kind: CalendarKind;
  title: string;
  next: number | null;
  when: string | null;
  says: string | null;
}

/** The hub's calendar: reminders with a date and tasks that end. Its prompt never leaves here. */
export function readCalendar(raw: unknown): CalendarEntry[] | null {
  const items = asRecord(raw)?.items;
  if (!Array.isArray(items)) return null;
  return items.flatMap((i) => {
    const o = asRecord(i);
    const key = o && str(o.key);
    const title = o && str(o.title);
    if (!o || !key || !title) return [];
    return [{ key, kind: o.kind === 'compito' ? ('compito' as const) : ('promemoria' as const), title, next: num(o.next), when: str(o.when), says: str(o.says) }];
  });
}

export interface CalendarDay {
  /** Midnight of the day, or null for the undated ones (last). */
  day: number | null;
  /** 0 today, 1 tomorrow, more after. */
  offset: number | null;
  items: CalendarEntry[];
}

function midnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The entries by day, soonest first; what already passed stays out. */
export function calendarDays(items: CalendarEntry[], now: number, kind: CalendarKind | null = null): CalendarDay[] {
  const today = midnight(now);
  const days = new Map<number | null, CalendarEntry[]>();
  const sorted = [...items].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
  for (const i of sorted) {
    if (kind && i.kind !== kind) continue;
    if (i.next !== null && i.next < now) continue;
    const day = i.next === null ? null : midnight(i.next);
    days.set(day, [...(days.get(day) ?? []), i]);
  }
  return [...days.entries()].map(([day, list]) => ({ day, offset: day === null ? null : Math.round((day - today) / 86_400_000), items: list }));
}

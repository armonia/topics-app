/**
 * AGENTS AND JOBS (hub-smistamento, HUBBR-13): who is working, read from five
 * places and sorted into the three filters of the level: running, waiting
 * and finished.
 *
 * - the sessions of Topics, from the same rows the card's badge counts
 *   (`useActiveAgentRows`), so the level cannot name work the badge does not;
 * - the sessions of the Claude proxy (`/api/switchboard/sessions`): the work
 *   that runs outside Topics and still spends the plans;
 * - the hub's queue (`/api/hub/queue`): the delegated jobs, running, in line,
 *   held by a quota until a time, done or failed;
 * - the workflows, as the hub's diary tells them (`/api/hub/diario?days=2`);
 * - the workflows' phases and the gates waiting for an approval, from the
 *   hub's automations (`/api/hub/automations`);
 * - what the hub sees running outside Topics, from its board and its live
 *   agents (`/api/hub/board`, `/api/hub/live`, read in `agentsJobsHub.ts`):
 *   Claude Code in a terminal or in the desktop app, Codex, Muse, the
 *   sub-agents, the live workflows, and why a held job is paused.
 *
 * Two rules the level exists to keep. The board's cards are NOT listed again:
 * a queued job born from a card (`ref` `card:...`, one of the night's, or a
 * text that names a card by its id) is a card of the Board, which already
 * has its place. And a title is NEVER the raw prompt: a delegated job only carries the text it was given, so the
 * title is the first readable sentence of it, or nothing, and the view then
 * says «delegated job» with the project.
 *
 * Pure reads: no fetch, no React. The view formats every word.
 */

import { gateWaitsOf, type GateWait } from './hubGates';
import { capFirst, jobTitle, repairName } from './jobTitle';
import { hubIconPath, hubWork, type HubAgentRow } from './agentsJobsHub';
import {
  PROXY_IDLE_MS, proxyActivity, proxyConflicts, proxyCostUsd, proxyState, proxyTimeline,
  type ProxyActivity, type ProxyConflict, type ProxyState,
} from './proxySessionDetail';

export { jobTitle, repairName };

export type JobFilter = 'running' | 'waiting' | 'finished';

export type JobSource = 'topic' | 'terminal' | 'proxy' | 'queue' | 'workflow' | 'outside' | 'subagent';

/** Which sentence the view uses when a row has no title of its own. */
export type JobFallback = 'job' | 'proxy' | 'jarvis' | 'workflowAgent' | 'outside' | 'subagent' | 'workflow' | null;

/**
 * What a job in the hub's line waits on: the hub's own reason for holding it
 * (its words), a free Mac for a background job, the job before it in line, or
 * nothing: it leaves at the next round.
 */
export type WaitsOn =
  | { kind: 'reason'; why: string }
  | { kind: 'macFree' }
  | { kind: 'after'; row: Pick<JobRow, 'title' | 'repairOf' | 'fallback' | 'project'> }
  | { kind: 'next' };

export type StepMark = 'done' | 'active' | 'failed' | 'todo';

export type JobTone = 'live' | 'you' | 'line' | 'quota' | 'ok' | 'failed';

export interface JobRow {
  key: string;
  source: JobSource;
  tone: JobTone;
  /** Readable title, or '' when the source gave none worth showing. */
  title: string;
  /** The chat channel of a Jarvis session on the proxy: the view words the title. */
  channel?: string | null;
  /** What a job in line waits on, for the view to word. */
  waitsOn?: WaitsOn;
  /** The automation a queued job repairs: the view words the title. */
  repairOf?: string | null;
  fallback: JobFallback;
  /** The moment the right-hand column tells: start (running), end (finished), restart (quota). */
  at: number | null;
  /** Position in the queue's line, from 1. */
  rank?: number;
  /** The same job more than once in a row of the list (×N). */
  fold?: number;
  provider?: string | null;
  project?: string | null;
  model?: string | null;
  requests?: number | null;
  tokens?: number | null;
  durationMs?: number | null;
  /** How many agents a workflow run used. */
  agents?: number | null;
  /** A workflow's phases, one mark each: the bar under the row. */
  steps?: StepMark[];
  /** The phase a running workflow is in, from 1. */
  step?: { n: number; of: number; title: string } | null;
  /** What the row waits on you for: the chat's question, the workflow's gate. */
  question?: string | null;
  /** The hub's own page for the row (`#automations/...`), when it has one. */
  hubPage?: string | null;
  exit?: number | null;
  /** The queue id a person may withdraw (queued jobs only). */
  cancelId?: string;
  /** Where a Topics row leads. */
  target?: { kind: 'topic' | 'terminal'; id: string; name: string };
  /** The project's icon: a Topics project's folder, or the hub's icon through the bridge. */
  iconPath?: string | null;
  hubIcon?: string | null;
  /** Who runs a session outside Topics: Claude, Codex, Muse, Jarvis, jcode. */
  runner?: string | null;
  /** Its share of the week, in percent. */
  weekPct?: number | null;
  /** A session silent on a live command: it works, and waits on that command. */
  onCommand?: boolean;
  /** The account a session of the proxy spends. */
  account?: string | null;
  /** The tool a session of the proxy runs now. */
  activity?: ProxyActivity | null;
  /** Since when a session of the proxy has asked nothing: past two minutes it waits for input. */
  idleSince?: number | null;
  /** The summariser's lines of a session of the proxy, never its prompts. */
  timeline?: string[];
  /** The cost at the model's list price, in dollars. */
  costUsd?: number | null;
  /** Why the hub holds a job in line until a time, its words. */
  pausedWhy?: string | null;
  /** When a job entered the hub's line. */
  queuedAt?: number | null;
  /** The automation a gate waits in: the row opens it in Automazioni. */
  automationKey?: string | null;
}

export type SectionId = 'topics' | 'outside' | 'subagents' | 'proxy' | 'queue' | 'workflows' | 'decide' | 'line' | 'quota' | 'failed' | 'today' | 'yesterday';

export interface JobSection {
  id: SectionId;
  rows: JobRow[];
}

export interface AgentsJobsView {
  running: JobSection[];
  waiting: JobSection[];
  finished: JobSection[];
  counts: Record<JobFilter, number>;
  /** How many wait on the person: the band on top of the running filter and the row's tail. */
  decide: number;
  /** The files two or more sessions of the proxy are editing at once. */
  conflicts: ProxyConflict[];
  /** The proxy: answering, its session monitor off, or silent. */
  proxyState: ProxyState;
}

/** A row of Topics, as `useActiveAgentRows` gives it. */
export interface TopicsAgentRow {
  id: string;
  kind: 'terminal' | 'topic';
  label: string;
  /** For a row waiting on you: its question, one line, as the attention store keeps it. */
  question?: string | null;
  /** When it entered its state: started working, began waiting, finished. In ms. */
  since?: number | null;
  /** The folder of the chat's project, for its icon and its name. */
  projectPath?: string | null;
}

export interface AgentsJobsInput {
  topics: { working: TopicsAgentRow[]; awaitingInput: TopicsAgentRow[]; finished: TopicsAgentRow[] };
  /** The hub's `/api/queue` answer, or null when the hub is not read. */
  queue: unknown;
  /** The hub's `/api/diario` answer, or null. */
  diary: unknown;
  /** The hub's `/api/automations` answer, or null: the workflows' phases and the gates waiting on you. */
  automations?: unknown;
  /** The proxy's `/api/sessions` answer, or null. */
  proxy: unknown;
  /** The hub's `/api/board` and `/api/live` answers, or null: who runs outside Topics. */
  board?: unknown;
  live?: unknown;
  now: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const DAY = 86_400_000;

/** Midnight of the local day `now` falls in. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}


/** «claude-sonnet-5-5» → «Sonnet 5.5»; any other id passes as it is. */
export function modelLabel(id: unknown): string | null {
  const s = str(id);
  if (!s) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(s);
  if (!m) return s;
  return `${capFirst(m[1]!)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

const PROVIDERS: Record<string, string> = { claude: 'Claude', codex: 'Codex', muse: 'Muse', jcode: 'jcode', gemini: 'Gemini', groq: 'Groq' };

/** The executor's proper name, as the hub's queue writes it lowercase. */
export function providerLabel(id: unknown): string | null {
  const s = str(id);
  if (!s) return null;
  return PROVIDERS[s.toLowerCase()] ?? capFirst(s);
}

/**
 * A card of the board named by its text: the hub's own card prompt, a job told
 * to handle a card, or a check of one card by its id. The hub keeps no `ref`
 * on those, and they are still the Board's work.
 */
const CARD_TEXT = /^card della board\b|^gestisci\s+(?:\p{L}+\s+)?card\b|\bcard\s+(?:topics\s+)?(?:che inizia con\s+)?['"‘«]?[0-9a-f]{8}\b/iu;

/** A queued job born from a card of the board: it is the Board's, not listed here. */
export function isBoardCard(item: Record<string, unknown>): boolean {
  const ref = str(item.ref);
  if (item.night === true || (ref !== null && ref.startsWith('card:'))) return true;
  const task = str(item.task);
  return task !== null && CARD_TEXT.test(task.slice(0, 400));
}

const PRIORITY: Record<string, number> = { alta: 0, normale: 1, bassa: 2 }; // allow-italian: the hub's wire values

interface QueueItem {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  waitUntil: number | null;
  provider: string | null;
  project: string | null;
  priority: number;
  exit: number | null;
  repairOf: string | null;
  /** The hub's reason for holding a job in line (its words), when it wrote one. */
  placeWhy: string | null;
  /** A job of the day: it leaves only with the Mac free. */
  background: boolean;
}

function queueItems(raw: unknown): QueueItem[] {
  const list = isObject(raw) && Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw : [];
  const out: QueueItem[] = [];
  for (const q of list) {
    if (!isObject(q) || isBoardCard(q)) continue;
    const id = str(q.id);
    const status = str(q.status);
    if (!id || !status) continue;
    out.push({
      id,
      title: jobTitle(q.task),
      status,
      createdAt: num(q.createdAt) ?? 0,
      startedAt: num(q.startedAt),
      endedAt: num(q.endedAt),
      waitUntil: num(q.waitUntil),
      provider: providerLabel(q.provider),
      project: str(q.project),
      priority: PRIORITY[str(q.priority) ?? 'normale'] ?? 1, // allow-italian: the hub's wire value
      exit: num(q.exit),
      repairOf: repairName(q.task),
      placeWhy: str(q.placeWhy),
      background: q.background === true,
    });
  }
  return out;
}

interface WorkflowPhase { title: string; total: number; done: number; failed: number }

interface WorkflowDetail {
  at: number;
  phases: WorkflowPhase[];
  agents: number | null;
  durationMs: number | null;
  runId: string | null;
  /** The run's own summary, made a title (Italian only, never the prompt): every run of a workflow reads apart. */
  title: string;
  /** Its agents' tokens, summed. */
  tokens: number | null;
}

/** The runs of every workflow by name, with their phases, from the hub's `/api/automations`. */
function workflowDetails(raw: unknown): Map<string, WorkflowDetail[]> {
  const out = new Map<string, WorkflowDetail[]>();
  const wf = isObject(raw) && isObject(raw.workflows) ? raw.workflows : null;
  const byName = wf && Array.isArray(wf.byName) ? wf.byName : [];
  for (const b of byName) {
    if (!isObject(b) || !Array.isArray(b.runs)) continue;
    const name = str(b.name);
    if (!name) continue;
    const runs: WorkflowDetail[] = [];
    for (const r of b.runs) {
      if (!isObject(r)) continue;
      const at = num(r.at);
      if (at === null) continue;
      const phases = (Array.isArray(r.phases) ? r.phases : []).filter(isObject).map((p) => ({
        title: str(p.title) ?? '',
        total: num(p.total) ?? 0,
        done: num(p.done) ?? 0,
        failed: num(p.failed) ?? 0,
      }));
      const steps = (Array.isArray(r.steps) ? r.steps : []).filter(isObject);
      const tokens = steps.reduce((sum, x) => sum + (num(x.tokens) ?? 0), 0);
      runs.push({ at, phases, agents: num(r.agents), durationMs: num(r.durationMs), runId: str(r.runId), title: jobTitle(r.summary), tokens: tokens || null });
    }
    out.set(name, runs);
  }
  return out;
}

/** The bar of a run's phases; a running one also says the phase it is in. */
export function workflowSteps(phases: WorkflowPhase[], running: boolean): { steps: StepMark[]; step: { n: number; of: number; title: string } | null } {
  const steps: StepMark[] = phases.map((p) => (p.failed > 0 ? 'failed' : p.total > 0 && p.done >= p.total ? 'done' : 'todo'));
  if (!running) return { steps, step: null };
  const at = steps.indexOf('todo');
  if (at < 0) return { steps, step: null };
  steps[at] = 'active';
  return { steps, step: { n: at + 1, of: steps.length, title: phases[at]!.title } };
}

/**
 * The agents and minutes the diary's summary of a run ends with: the rest of it
 * is the run's own prose (a prompt cut short), and stays out of the row.
 */
export function workflowWhat(what: unknown): { agents: number | null; durationMs: number | null } {
  const m = /(\d+)\s+agent[ei]\b(?:\s*,\s*(\d+)\s*min)?/i.exec(typeof what === 'string' ? what : ''); // allow-italian: the hub's wire words
  if (!m) return { agents: null, durationMs: null };
  return { agents: Number(m[1]), durationMs: m[2] ? Number(m[2]) * 60_000 : null };
}

interface WorkflowRun {
  key: string;
  title: string;
  outcome: string | null;
  at: number;
  agents: number | null;
  durationMs: number | null;
  steps: StepMark[];
  step: { n: number; of: number; title: string } | null;
  tokens: number | null;
  runId: string | null;
}

function workflowRuns(raw: unknown, details: Map<string, WorkflowDetail[]>): WorkflowRun[] {
  const list = isObject(raw) && Array.isArray(raw.items) ? raw.items : [];
  const out: WorkflowRun[] = [];
  list.forEach((d, i) => {
    if (!isObject(d) || d.kind !== 'workflow') return;
    const at = num(d.at);
    const title = str(d.title);
    if (at === null || !title) return;
    const ref = str(d.ref);
    const outcome = str(d.outcome);
    const runs = ref?.startsWith('wf:') ? details.get(ref.slice(3)) ?? [] : [];
    // The run of the diary's line: the latest for one still running, else the closest in time.
    const run = outcome === 'running'
      ? runs.reduce<WorkflowDetail | null>((best, r) => (!best || r.at > best.at ? r : best), null)
      : runs.reduce<WorkflowDetail | null>((best, r) => (!best || Math.abs(r.at - at) < Math.abs(best.at - at) ? r : best), null);
    const said = workflowWhat(d.what);
    const bar = run && run.phases.length ? workflowSteps(run.phases, outcome === 'running') : { steps: [], step: null };
    out.push({
      key: `wf:${ref ?? title}:${at}:${i}`,
      // The run's summary when it reads as a title, else the workflow's name.
      title: run?.title || title,
      outcome,
      at,
      agents: run?.agents ?? said.agents,
      durationMs: run?.durationMs ?? said.durationMs,
      tokens: run?.tokens ?? null,
      runId: run?.runId ?? null,
      ...bar,
    });
  });
  return out;
}

interface ProxySession {
  id: string;
  /** The project the session works in: its repository, else a project folder its commands name. */
  project: string | null;
  /** The chat channel a Jarvis turn came from (WhatsApp, Discord), when the session is one. */
  channel: string | null;
  /** The session is an agent a workflow started. */
  workflowAgent: boolean;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  requests: number | null;
  tokens: number | null;
  durationMs: number | null;
  account: string | null;
  activity: ProxyActivity | null;
  lastActiveAt: number | null;
  timeline: string[];
  costUsd: number | null;
}

const CHANNELS: Record<string, string> = { whatsapp: 'WhatsApp', discord: 'Discord', telegram: 'Telegram', imessage: 'iMessage', slack: 'Slack' };

/** A Jarvis turn opens on «(turno N · whatsapp · ...)»: the channel, never the text after it. */
const TURN = /^\(turno\s+\d+\s+·\s+([\p{L}]+)/iu; // allow-italian: the gateway's own turn header, matched as data
const WORKFLOW_AGENT = /^\[workflow harness\b/i;
// A project folder a command names, followed by more of the path: a name cut short by the proxy's clip is not a name.
const PROJECT_DIR = /\/Projects\/([\w.-]+)(?=[/\s'"&;|)])/;

/**
 * What tells one proxy session from the next without its prose: the timeline
 * is the session's own prompts and answers, so only its structure is read
 * (a Jarvis turn's channel, a workflow's brief, a project folder in a command).
 */
function proxySignals(segments: Record<string, unknown>[]): { project: string | null; channel: string | null; workflowAgent: boolean } {
  let project: string | null = null;
  let channel: string | null = null;
  let workflowAgent = false;
  for (const s of segments) {
    const repo = str(s.repo);
    if (repo && !project) project = repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? null;
    const texts: Array<{ type: string | null; text: string }> = [];
    const activity = str(s.currentActivity);
    if (activity) texts.push({ type: 'action', text: activity });
    for (const t of Array.isArray(s.timeline) ? s.timeline : []) {
      if (isObject(t) && typeof t.text === 'string') texts.push({ type: str(t.type), text: t.text });
    }
    for (const t of texts) {
      if (t.type === 'input') {
        const turn = TURN.exec(t.text.trim());
        if (turn && !channel) channel = CHANNELS[turn[1]!.toLowerCase()] ?? capFirst(turn[1]!);
        if (WORKFLOW_AGENT.test(t.text.trim())) workflowAgent = true;
      } else if (!project) {
        const dir = PROJECT_DIR.exec(t.text);
        if (dir) project = dir[1]!;
      }
    }
  }
  return { project, channel, workflowAgent };
}

/**
 * The proxy's sessions, one row per session: the proxy writes a session again
 * for every model it switched to, and a session still at work also has its
 * older segments among the recent ones. A session at work is only running;
 * an ended one shows its latest segment.
 */
function proxySessions(raw: unknown): { active: ProxySession[]; recent: ProxySession[] } {
  const listOf = (key: 'active' | 'recent') => (isObject(raw) && Array.isArray(raw[key]) ? raw[key] : []).filter(isObject);
  const active = listOf('active');
  const recent = listOf('recent');
  const segments = new Map<string, Record<string, unknown>[]>();
  for (const s of [...active, ...recent]) {
    const id = str(s.id);
    if (id) segments.set(id, [...(segments.get(id) ?? []), s]);
  }
  const pick = (list: Record<string, unknown>[], skip: Set<string>): ProxySession[] => {
    const byId = new Map<string, ProxySession>();
    for (const s of list) {
      const id = str(s.id);
      if (!id || skip.has(id)) continue;
      const row: ProxySession = {
        id,
        ...proxySignals(segments.get(id) ?? [s]),
        model: modelLabel(s.model),
        startedAt: num(s.startedAt),
        endedAt: num(s.completedAt),
        requests: num(s.requestCount),
        tokens: (num(s.totalInputTokens) ?? 0) + (num(s.totalOutputTokens) ?? 0) || null,
        durationMs: num(s.duration),
        account: str(s.account),
        activity: proxyActivity(s.currentActivity),
        lastActiveAt: num(s.lastActiveAt),
        timeline: proxyTimeline(segments.get(id) ?? [s]),
        costUsd: proxyCostUsd(s.model, s.totalInputTokens, s.totalOutputTokens),
      };
      const prev = byId.get(id);
      if (!prev || (row.endedAt ?? row.startedAt ?? 0) > (prev.endedAt ?? prev.startedAt ?? 0)) byId.set(id, row);
    }
    return [...byId.values()];
  };
  const live = pick(active, new Set());
  return { active: live, recent: pick(recent, new Set(live.map((s) => s.id))) };
}

/** Two rows read the same in the list: same words, same kind, same place, same model, same account, same state. */
function sameLabel(a: JobRow, b: JobRow): boolean {
  if (!(a.title || a.fallback || a.repairOf)) return false;
  // A session that says what it is doing, or what it did, is not the same as the next one.
  if (a.activity || b.activity || a.timeline?.length || b.timeline?.length) return false;
  return a.title === b.title && a.fallback === b.fallback && (a.repairOf ?? null) === (b.repairOf ?? null)
    && (a.channel ?? null) === (b.channel ?? null) && (a.project ?? null) === (b.project ?? null) && (a.model ?? null) === (b.model ?? null)
    && (a.account ?? null) === (b.account ?? null) && (a.runner ?? null) === (b.runner ?? null)
    && !!a.onCommand === !!b.onCommand && (a.pausedWhy ?? null) === (b.pausedWhy ?? null);
}

const add = (x: number | null | undefined, y: number | null | undefined): number | null =>
  (x === null || x === undefined) && (y === null || y === undefined) ? null : (x ?? 0) + (y ?? 0);
const most = (x: number | null | undefined, y: number | null | undefined): number | null =>
  (x === null || x === undefined) ? y ?? null : (y === null || y === undefined) ? x : Math.max(x, y);

/**
 * Rows that read the same, with the same tone and source, become one, counted
 * (×N), where the first of them stands: twenty identical jobs are one line
 * to read. The tokens, requests, agents, cost and share of the week are the
 * sums; the duration is the longest.
 */
export function foldRows(rows: JobRow[]): JobRow[] {
  const out: JobRow[] = [];
  for (const r of rows) {
    const at = r.target ? -1 : out.findIndex((o) => o.tone === r.tone && o.source === r.source && !o.target && sameLabel(o, r));
    if (at < 0) {
      out.push(r);
      continue;
    }
    const o = out[at]!;
    out[at] = {
      ...o,
      fold: (o.fold ?? 1) + 1,
      tokens: add(o.tokens, r.tokens),
      requests: add(o.requests, r.requests),
      agents: add(o.agents, r.agents),
      costUsd: add(o.costUsd, r.costUsd),
      weekPct: add(o.weekPct, r.weekPct),
      durationMs: most(o.durationMs, r.durationMs),
    };
  }
  return out;
}

/** The last folder of a path: the project's name. */
const folderName = (path: string | null | undefined): string | null => (path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null : null);

const topicRow = (r: TopicsAgentRow, tone: JobTone): JobRow => ({
  key: `${r.kind}:${r.id}`,
  source: r.kind,
  tone,
  title: r.label,
  fallback: null,
  // Since when it works, waits on you, or since it finished.
  at: r.since || null,
  question: tone === 'you' ? r.question ?? null : null,
  target: { kind: r.kind, id: r.id, name: r.label },
  project: folderName(r.projectPath),
  iconPath: r.projectPath ?? null,
});

const gateRow = (g: GateWait): JobRow => ({
  key: `gate:${g.key}`,
  source: 'workflow',
  tone: 'you',
  title: g.title,
  fallback: null,
  at: g.since,
  question: g.reason,
  hubPage: `#automations/${encodeURIComponent(g.key)}`,
  automationKey: g.key,
});

const queueRow = (q: QueueItem, tone: JobTone, at: number | null, icons: Map<string, string>): JobRow => ({
  key: `queue:${q.id}`,
  source: 'queue',
  tone,
  title: q.title,
  repairOf: q.repairOf,
  fallback: q.title || q.repairOf ? null : 'job',
  at,
  provider: q.provider,
  project: q.project,
  exit: q.exit,
  durationMs: q.startedAt !== null && q.endedAt !== null ? q.endedAt - q.startedAt : null,
  hubIcon: hubIconPath(icons, q.project),
  queuedAt: q.createdAt || null,
});

const proxyRow = (s: ProxySession, tone: JobTone, at: number | null, icons: Map<string, string>, now: number): JobRow => ({
  key: `proxy:${s.id}:${at ?? 0}`,
  source: 'proxy',
  tone,
  title: '',
  fallback: s.workflowAgent ? 'workflowAgent' : s.channel ? 'jarvis' : 'proxy',
  channel: s.channel,
  project: s.project,
  at,
  model: s.model,
  requests: s.requests,
  tokens: s.tokens,
  durationMs: s.durationMs,
  account: s.account,
  hubIcon: hubIconPath(icons, s.project),
  costUsd: s.costUsd,
  timeline: s.timeline,
  // At work: what it runs now, or since when it waits for its next input.
  activity: tone === 'live' ? s.activity : null,
  idleSince: tone === 'live' && s.lastActiveAt !== null && now - s.lastActiveAt > PROXY_IDLE_MS ? s.lastActiveAt : null,
});

const workflowRow = (w: WorkflowRun, tone: JobTone): JobRow => ({
  key: w.key,
  source: 'workflow',
  tone,
  title: w.title,
  fallback: null,
  at: w.at,
  agents: w.agents,
  durationMs: w.durationMs,
  steps: w.steps,
  step: w.step,
  tokens: w.tokens,
});

/** A session, sub-agent or live workflow the hub sees outside Topics. */
const hubRow = (h: HubAgentRow): JobRow => ({
  key: h.key,
  source: h.kind === 'session' ? 'outside' : h.kind === 'subagent' ? 'subagent' : 'workflow',
  tone: 'live',
  title: h.title,
  fallback: h.title ? null : h.kind === 'session' ? 'outside' : h.kind === 'subagent' ? 'subagent' : 'workflow',
  at: h.startedAt,
  project: h.project,
  hubIcon: h.icon && h.icon.startsWith('/api/') ? `/api/hub/${h.icon.slice('/api/'.length)}` : null,
  runner: h.runner,
  model: h.model,
  tokens: h.tokens,
  weekPct: h.weekPct,
  agents: h.kind === 'workflow' ? h.agents : null,
  onCommand: h.onCommand,
});

const section = (id: SectionId, rows: JobRow[]): JobSection[] => (rows.length ? [{ id, rows }] : []);
const byAtNewestFirst = (a: JobRow, b: JobRow) => (b.at ?? Number.POSITIVE_INFINITY) - (a.at ?? Number.POSITIVE_INFINITY);
const rowsOf = (sections: JobSection[]) => sections.reduce((n, s) => n + s.rows.length, 0);

/** Everything the level shows, per filter, with the count each filter carries. */
export function agentsJobs(input: AgentsJobsInput): AgentsJobsView {
  const { topics, now } = input;
  const today = startOfDay(now);
  const yesterday = today - DAY;
  const queue = queueItems(input.queue);
  const flows = workflowRuns(input.diary, workflowDetails(input.automations));
  const gates = gateWaitsOf(input.automations);
  const proxy = proxySessions(input.proxy);
  const proxyActive = proxy.active;
  const proxyRecent = proxy.recent.filter((s) => (s.endedAt ?? 0) >= yesterday);
  const hub = hubWork(input.board ?? null, input.live ?? null);
  const icons = hub.icons;

  // A workflow the diary tells and the hub sees live is one row: the diary's phases, the hub's agents and tokens.
  const liveFlows = new Map(hub.workflows.filter((w) => w.runId).map((w) => [w.runId!, w]));
  const flowRows = flows.filter((w) => w.outcome === 'running').map((w) => {
    const h = w.runId ? liveFlows.get(w.runId) : undefined;
    if (h) liveFlows.delete(w.runId!);
    const row = workflowRow(w, 'live');
    return h ? { ...row, agents: h.agents ?? row.agents, tokens: h.tokens ?? row.tokens, weekPct: h.weekPct, project: h.project, hubIcon: hubRow(h).hubIcon } : row;
  });
  const hubFlows = hub.workflows.filter((w) => !w.runId || liveFlows.has(w.runId)).map(hubRow);

  // RUNNING
  const running: JobSection[] = [
    ...section('topics', topics.working.map((r) => topicRow(r, 'live'))),
    ...section('outside', foldRows(hub.sessions.map(hubRow))),
    ...section('subagents', foldRows(hub.subagents.map(hubRow))),
    ...section('proxy', foldRows(proxyActive.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).map((s) => proxyRow(s, 'live', s.startedAt, icons, now)))),
    ...section('queue', foldRows(queue.filter((q) => q.status === 'running').map((q) => queueRow(q, 'live', q.startedAt ?? q.createdAt, icons)))),
    ...section('workflows', [...flowRows, ...hubFlows].sort(byAtNewestFirst)),
  ];

  // WAITING: yours first, then the line in the hub's own order, then the ones a quota holds.
  const queued = queue.filter((q) => q.status === 'queued');
  const held = queued.filter((q) => q.waitUntil !== null && q.waitUntil > now).sort((a, b) => (a.waitUntil ?? 0) - (b.waitUntil ?? 0));
  const line = queued.filter((q) => !(q.waitUntil !== null && q.waitUntil > now))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const lineItems = new Map(line.map((q) => [`queue:${q.id}`, q]));
  const lineRows = foldRows(line.map((q) => ({ ...queueRow(q, 'line', q.createdAt, icons), cancelId: q.id })))
    .map((r, i, all): JobRow => {
      const q = lineItems.get(r.key);
      const prev = all[i - 1];
      const waitsOn: WaitsOn = q?.placeWhy ? { kind: 'reason', why: q.placeWhy }
        : q?.background ? { kind: 'macFree' }
        : prev ? { kind: 'after', row: { title: prev.title, repairOf: prev.repairOf, fallback: prev.fallback, project: prev.project } }
        : { kind: 'next' };
      return { ...r, rank: i + 1, waitsOn };
    });
  const waiting: JobSection[] = [
    // Oldest first: the one waiting longest has waited enough.
    ...section('decide', [...topics.awaitingInput.map((r) => topicRow(r, 'you')), ...gates.map(gateRow)]
      .sort((a, b) => (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY))),
    ...section('line', lineRows),
    // The hub says why it holds each: the subscription that brakes it, a hold by hand, the budget.
    ...section('quota', foldRows(held.map((q) => ({ ...queueRow(q, 'quota', q.waitUntil, icons), cancelId: q.id, pausedWhy: hub.paused.get(q.id)?.why ?? null })))),
  ];

  // FINISHED: what failed on top, then today and yesterday.
  const ended: JobRow[] = [
    ...queue.filter((q) => (q.status === 'done' || q.status === 'failed') && (q.endedAt ?? q.createdAt) >= yesterday)
      .map((q) => queueRow(q, q.status === 'failed' ? 'failed' : 'ok', q.endedAt ?? q.createdAt, icons)),
    ...proxyRecent.map((s) => proxyRow(s, 'ok', s.endedAt, icons, now)),
    ...flows.filter((w) => w.outcome !== 'running' && w.at >= yesterday)
      .map((w) => workflowRow(w, w.outcome === 'error' ? 'failed' : 'ok')),
  ].sort(byAtNewestFirst);
  const finishedTopics = topics.finished.map((r) => topicRow(r, 'ok'));
  const finished: JobSection[] = [
    ...section('failed', ended.filter((r) => r.tone === 'failed')),
    ...section('today', foldRows([...finishedTopics, ...ended.filter((r) => r.tone === 'ok' && (r.at ?? now) >= today)])),
    ...section('yesterday', foldRows(ended.filter((r) => r.tone === 'ok' && r.at !== null && r.at < today))),
  ];

  return {
    running,
    waiting,
    finished,
    counts: { running: rowsOf(running), waiting: rowsOf(waiting), finished: rowsOf(finished) },
    decide: topics.awaitingInput.length + gates.length,
    conflicts: proxyConflicts(input.proxy),
    proxyState: proxyState(input.proxy),
  };
}

/** The filter the level opens on: the waiting filter when somebody waits on you, else what is running. */
export function openingFilter(view: AgentsJobsView): JobFilter {
  return view.decide > 0 ? 'waiting' : 'running';
}

/** The request that withdraws a job waiting in the hub's line. */
export function cancelRequest(id: string): { path: string; init: { method: 'DELETE' } } {
  return { path: `/api/hub/queue?id=${encodeURIComponent(id)}`, init: { method: 'DELETE' } };
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala

/**
 * AGENTS AND JOBS (hub-smistamento, HUBBR-13): who is working, read from four
 * places and sorted into the three filters of the level, In corso, In attesa
 * and Finiti.
 *
 * - the sessions of Topics, from the same rows the card's badge counts
 *   (`useActiveAgentRows`), so the level cannot name work the badge does not;
 * - the sessions of the Claude proxy (`/api/switchboard/sessions`): the work
 *   that runs outside Topics and still spends the plans;
 * - the hub's queue (`/api/hub/queue`): the delegated jobs, running, in line,
 *   held by a quota until a time, done or failed;
 * - the workflows, as the hub's diary tells them (`/api/hub/diario?days=2`).
 *
 * Two rules the level exists to keep. The board's cards are NOT listed again:
 * a queued job born from a card (`ref` `card:...`, or one of the night's) is
 * a card of the Board, which already has its place. And a title is NEVER the
 * raw prompt: a delegated job only carries the text it was given, so the
 * title is the first readable sentence of it, or nothing, and the view then
 * says «delegated job» with the project.
 *
 * Pure reads: no fetch, no React. The view formats every word.
 */

export type JobFilter = 'running' | 'waiting' | 'finished';

export type JobSource = 'topic' | 'terminal' | 'proxy' | 'queue' | 'workflow';

/** Which sentence the view uses when a row has no title of its own. */
export type JobFallback = 'job' | 'proxy' | null;

export type JobTone = 'live' | 'you' | 'line' | 'quota' | 'ok' | 'failed';

export interface JobRow {
  key: string;
  source: JobSource;
  tone: JobTone;
  /** Readable title, or '' when the source gave none worth showing. */
  title: string;
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
  /** The hub's own Italian detail of a workflow run («3 agenti, 18 min»). */
  what?: string | null;
  exit?: number | null;
  /** The queue id a person may withdraw (queued jobs only). */
  cancelId?: string;
  /** Where a Topics row leads. */
  target?: { kind: 'topic' | 'terminal'; id: string; name: string };
}

export type SectionId = 'topics' | 'proxy' | 'queue' | 'workflows' | 'decide' | 'line' | 'quota' | 'failed' | 'today' | 'yesterday';

export interface JobSection {
  id: SectionId;
  rows: JobRow[];
}

export interface AgentsJobsView {
  running: JobSection[];
  waiting: JobSection[];
  finished: JobSection[];
  counts: Record<JobFilter, number>;
  /** How many wait on the person: the band on top of «In corso» and the row's tail. */
  decide: number;
}

/** A row of Topics, as `useActiveAgentRows` gives it. */
export interface TopicsAgentRow {
  id: string;
  kind: 'terminal' | 'topic';
  label: string;
}

export interface AgentsJobsInput {
  topics: { working: TopicsAgentRow[]; awaitingInput: TopicsAgentRow[]; finished: TopicsAgentRow[] };
  /** The hub's `/api/queue` answer, or null when the hub is not read. */
  queue: unknown;
  /** The hub's `/api/diario` answer, or null. */
  diary: unknown;
  /** The proxy's `/api/sessions` answer, or null. */
  proxy: unknown;
  now: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const DAY = 86_400_000;
const TITLE_MAX = 64;

/** Midnight of the local day `now` falls in. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Words that make a sentence English: the hub writes in Italian, a prompt in
// English is a harness's own prose and not a title for this view.
const ENGLISH = new Set(['the', 'and', 'of', 'to', 'with', 'for', 'this', 'that', 'is', 'are', 'on', 'an', 'from', 'your', 'you', 'be', 'it', 'in', 'up', 'into', 'new']);
const ENGLISH_ONLY = new Set(['the', 'and', 'of', 'to', 'with', 'for', 'this', 'that', 'is', 'are', 'your', 'you', 'be', 'into']);

function looksEnglish(s: string): boolean {
  const words = s.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  const hits = words.filter((w) => ENGLISH.has(w)).length;
  const strong = words.some((w) => ENGLISH_ONLY.has(w));
  return strong && hits >= 2;
}

/** A word in capitals is shouting, not a name: kept only up to three letters (PR, CI, API). */
const calm = (s: string) => s.replace(/\b[A-ZÀ-Ý]{4,}\b/g, (w) => w.toLowerCase());

function clip(s: string, n = TITLE_MAX): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

const capFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * The title of a delegated job, from the text it was given: its first readable
 * sentence, without paths, commands, parentheses, hashes or flags, at most
 * 64 characters. '' when nothing readable is left (a command wrapper, a prompt
 * in English, a preamble with only a path): the view says so instead of
 * showing the prompt.
 */
export function jobTitle(raw: unknown): string {
  let s = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // A card of the board names itself between the quotes: «Card della board X «title».»
  const card = /^Card della board[^«]*«(.+?)»(?:\.|\s|$)/i.exec(s);
  if (card) return clip(capFirst(card[1]!.trim()));
  // A wrapper that runs a command is not the work; the work is in the command.
  if (/^(esegui|lancia|run|execute)\b[^.]{0,40}\bcomando\b/i.test(s) || /^(run|execute)\b[^.]{0,30}\bcommand\b/i.test(s)) return '';
  // «Progetto: <path>, ramo ...» is the preamble of a task, nothing to read in it.
  if (/^(progetto|project|repo|cartella|worktree)\s*:/i.test(s)) return '';
  s = s
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^(task|compito|goal|obiettivo|richiesta|contesto|context|fase \w+)\s*[:.-]\s*/i, '')
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/`[^`]*`?/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?<![\w/])(~|\.{1,2})?\/[^\s,;]+/g, ' ')
    .replace(/\b[\w.-]+\/[^\s,;]*/g, ' ')
    .replace(/\b[\w.-]+\.(jsonl?|mjs|cjs|js|ts|tsx|jsx|swift|rs|py|sh|md|ya?ml|html|css|toml)\b/gi, ' ')
    .replace(/\b[0-9a-f]{7,}\b/gi, ' ')
    .replace(/\b\w+=\S+/g, ' ')
    .replace(/\s--?[a-z][\w-]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  s = s.split(/(?<=[.!?])\s|\s[\u2014\u2013-]\s|;\s/)[0] ?? '';
  // «Tray: verifica» keeps its name; «Riprendi il lavoro di ieri: lancia lo script» stops at the colon.
  const colon = s.indexOf(': ');
  if (colon > 0 && s.slice(0, colon).split(' ').length >= 3) s = s.slice(0, colon);
  s = calm(s.replace(/[.:,;]+$/, '').trim());
  if (s.length < 3 || !/[a-zà-ý]{3}/i.test(s)) return '';
  if (looksEnglish(s)) return '';
  return clip(capFirst(s));
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

/** A queued job born from a card of the board: it is the Board's, not listed here. */
function isBoardCard(item: Record<string, unknown>): boolean {
  const ref = str(item.ref);
  return item.night === true || (ref !== null && ref.startsWith('card:'));
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
    });
  }
  return out;
}

interface WorkflowRun {
  key: string;
  title: string;
  outcome: string | null;
  at: number;
  what: string | null;
}

function workflowRuns(raw: unknown): WorkflowRun[] {
  const list = isObject(raw) && Array.isArray(raw.items) ? raw.items : [];
  const out: WorkflowRun[] = [];
  list.forEach((d, i) => {
    if (!isObject(d) || d.kind !== 'workflow') return;
    const at = num(d.at);
    const title = str(d.title);
    if (at === null || !title) return;
    out.push({ key: `wf:${str(d.ref) ?? title}:${at}:${i}`, title, outcome: str(d.outcome), at, what: str(d.what) });
  });
  return out;
}

interface ProxySession {
  id: string;
  repo: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  requests: number | null;
  tokens: number | null;
  durationMs: number | null;
}

function proxySessions(raw: unknown, key: 'active' | 'recent'): ProxySession[] {
  const list = isObject(raw) && Array.isArray(raw[key]) ? raw[key] : [];
  const byId = new Map<string, ProxySession>();
  for (const s of list) {
    if (!isObject(s)) continue;
    const id = str(s.id);
    if (!id) continue;
    const repo = str(s.repo);
    const row: ProxySession = {
      id,
      repo: repo ? repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? null : null,
      model: modelLabel(s.model),
      startedAt: num(s.startedAt),
      endedAt: num(s.completedAt),
      requests: num(s.requestCount),
      tokens: (num(s.totalInputTokens) ?? 0) + (num(s.totalOutputTokens) ?? 0) || null,
      durationMs: num(s.duration),
    };
    // The proxy writes a session again for every model it switched to: one session, the latest segment.
    const prev = byId.get(id);
    if (!prev || (row.endedAt ?? row.startedAt ?? 0) > (prev.endedAt ?? prev.startedAt ?? 0)) byId.set(id, row);
  }
  return [...byId.values()];
}

/** Consecutive rows with the same title and tone become one, counted (×N). */
export function foldRows(rows: JobRow[]): JobRow[] {
  const out: JobRow[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && r.title && last.title === r.title && last.tone === r.tone && last.source === r.source && !last.target) {
      out[out.length - 1] = { ...last, fold: (last.fold ?? 1) + 1 };
      continue;
    }
    out.push(r);
  }
  return out;
}

const topicRow = (r: TopicsAgentRow, tone: JobTone): JobRow => ({
  key: `${r.kind}:${r.id}`,
  source: r.kind,
  tone,
  title: r.label,
  fallback: null,
  at: null,
  target: { kind: r.kind, id: r.id, name: r.label },
});

const queueRow = (q: QueueItem, tone: JobTone, at: number | null): JobRow => ({
  key: `queue:${q.id}`,
  source: 'queue',
  tone,
  title: q.title,
  fallback: q.title ? null : 'job',
  at,
  provider: q.provider,
  project: q.project,
  exit: q.exit,
  durationMs: q.startedAt !== null && q.endedAt !== null ? q.endedAt - q.startedAt : null,
});

const proxyRow = (s: ProxySession, tone: JobTone, at: number | null): JobRow => ({
  key: `proxy:${s.id}:${at ?? 0}`,
  source: 'proxy',
  tone,
  title: s.repo ?? '',
  fallback: s.repo ? null : 'proxy',
  at,
  model: s.model,
  requests: s.requests,
  tokens: s.tokens,
  durationMs: s.durationMs,
});

const workflowRow = (w: WorkflowRun, tone: JobTone): JobRow => ({
  key: w.key,
  source: 'workflow',
  tone,
  title: w.title,
  fallback: null,
  at: w.at,
  what: w.what,
});

const section = (id: SectionId, rows: JobRow[]): JobSection[] => (rows.length ? [{ id, rows }] : []);
const byAtDesc = (a: JobRow, b: JobRow) => (b.at ?? Number.POSITIVE_INFINITY) - (a.at ?? Number.POSITIVE_INFINITY);
const rowsOf = (sections: JobSection[]) => sections.reduce((n, s) => n + s.rows.length, 0);

/** Everything the level shows, per filter, with the count each filter carries. */
export function agentsJobs(input: AgentsJobsInput): AgentsJobsView {
  const { topics, now } = input;
  const today = startOfDay(now);
  const yesterday = today - DAY;
  const queue = queueItems(input.queue);
  const flows = workflowRuns(input.diary);
  const proxyActive = proxySessions(input.proxy, 'active');
  const proxyRecent = proxySessions(input.proxy, 'recent').filter((s) => (s.endedAt ?? 0) >= yesterday);

  // IN CORSO
  const running: JobSection[] = [
    ...section('topics', topics.working.map((r) => topicRow(r, 'live'))),
    ...section('proxy', proxyActive.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).map((s) => proxyRow(s, 'live', s.startedAt))),
    ...section('queue', queue.filter((q) => q.status === 'running').map((q) => queueRow(q, 'live', q.startedAt ?? q.createdAt))),
    ...section('workflows', flows.filter((w) => w.outcome === 'running').sort((a, b) => b.at - a.at).map((w) => workflowRow(w, 'live'))),
  ];

  // IN ATTESA: yours first, then the line in the hub's own order, then the ones a quota holds.
  const queued = queue.filter((q) => q.status === 'queued');
  const held = queued.filter((q) => q.waitUntil !== null && q.waitUntil > now).sort((a, b) => (a.waitUntil ?? 0) - (b.waitUntil ?? 0));
  const line = queued.filter((q) => !(q.waitUntil !== null && q.waitUntil > now))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const lineRows = foldRows(line.map((q) => ({ ...queueRow(q, 'line', q.createdAt), cancelId: q.id })))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const waiting: JobSection[] = [
    ...section('decide', topics.awaitingInput.map((r) => topicRow(r, 'you'))),
    ...section('line', lineRows),
    ...section('quota', held.map((q) => ({ ...queueRow(q, 'quota', q.waitUntil), cancelId: q.id }))),
  ];

  // FINITI: what failed on top, then today and yesterday.
  const ended: JobRow[] = [
    ...queue.filter((q) => (q.status === 'done' || q.status === 'failed') && (q.endedAt ?? q.createdAt) >= yesterday)
      .map((q) => queueRow(q, q.status === 'failed' ? 'failed' : 'ok', q.endedAt ?? q.createdAt)),
    ...proxyRecent.map((s) => proxyRow(s, 'ok', s.endedAt)),
    ...flows.filter((w) => w.outcome !== 'running' && w.at >= yesterday)
      .map((w) => workflowRow(w, w.outcome === 'error' ? 'failed' : 'ok')),
  ].sort(byAtDesc);
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
    decide: topics.awaitingInput.length,
  };
}

/** The filter the level opens on: «In attesa» when somebody waits on you, else what is running. */
export function openingFilter(view: AgentsJobsView): JobFilter {
  return view.decide > 0 ? 'waiting' : 'running';
}

/** The request that withdraws a job waiting in the hub's line. */
export function cancelRequest(id: string): { path: string; init: { method: 'DELETE' } } {
  return { path: `/api/hub/queue?id=${encodeURIComponent(id)}`, init: { method: 'DELETE' } };
}

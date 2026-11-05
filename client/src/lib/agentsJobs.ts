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
 *   hub's automations (`/api/hub/automations`).
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

export type JobFilter = 'running' | 'waiting' | 'finished';

export type JobSource = 'topic' | 'terminal' | 'proxy' | 'queue' | 'workflow';

/** Which sentence the view uses when a row has no title of its own. */
export type JobFallback = 'job' | 'proxy' | 'jarvis' | 'workflowAgent' | null;

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
  /** How many wait on the person: the band on top of the running filter and the row's tail. */
  decide: number;
}

/** A row of Topics, as `useActiveAgentRows` gives it. */
export interface TopicsAgentRow {
  id: string;
  kind: 'terminal' | 'topic';
  label: string;
  /** For a row waiting on you: its question, one line, as the attention store keeps it. */
  question?: string | null;
  /** When it started waiting, in ms. */
  since?: number | null;
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
const ENGLISH_ONLY = new Set(['the', 'and', 'of', 'to', 'with', 'for', 'this', 'that', 'is', 'are', 'your', 'you', 'be', 'into', 'adversarial']);

function looksEnglish(s: string): boolean {
  const words = s.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  const hits = words.filter((w) => ENGLISH.has(w)).length;
  const strong = words.some((w) => ENGLISH_ONLY.has(w));
  return strong && (hits >= 2 || words.length <= 6);
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

/** Where a token that is not prose was taken out: a path, a file, a command, a link. */
const CUT = '\uE000';

// The patterns below are the hub's own Italian phrasing of a prompt; they are
// data, matched against what the person and the agents wrote.
const WRAPPER = /^(?:esegui|lancia|run|execute)\b[^.]{0,40}\b(?:comando|command)\b|^(?:esegui|svolgi|fai|leggi|segui)\b[^.]{0,30}\b(?:descritt|scritt|indicat)\w*\s+(?:in|nel)\b|^(?:esegui|lancia|fai|run|execute|comando)\s*:/i; // allow-italian: the prompts' own words, matched as data
const LOCATION = /^(?:nel|nella|in|lavori in|lavora in)\s+(?:(?:il|lo|la)\s+)?(?:git\s+)?(?:worktree|repo|cartella|progetto|ramo)?\b[^:]{0,160}?:\s+/i; // allow-italian: the prompts' own words, matched as data
const LOCATION_BARE = new RegExp(`^(?:nel|nella|in)\\s+(?:(?:worktree|repo|cartella|progetto)\\s+)?${CUT}\\s*,?\\s*`, 'i'); // allow-italian: the prompts' own words, matched as data
const PREAMBLE = /^(?:progetto|repo|worktree|cartella|ramo|branch|sorgente|fonte|anteprima)\b/i; // allow-italian: the prompts' own words, matched as data
const ROLE = /^sei\s+(?:un|una|il|la|lo)\b/i; // allow-italian: the prompts' own words, matched as data
/** A verifier's brief: what it checks is a claim, not a job with a name. */
const CHECKER = /^sei\s+un\w*\s+(?:verifier|verificatore|revisore|critico)\b/i; // allow-italian: the prompts' own words, matched as data
const RULE = /^(?:non|mai|niente|nessun\w*|regole|usa|puoi|devi|ricorda|lavora\s+(?:solo|su|nel|in|qui)|leggi\s+prima|prima\s+leggi|read\s+first|stato|lingua|language|output|formato|stile|browser)\b|\b(?:mai|vietat[oa])\b/i; // allow-italian: the prompts' own words, matched as data
const LABEL = /^(?:task|compito|goal|obiettivo|richiesta[^:]{0,25}|contesto|context|fase\s+\w+|bug[^:]{0,40}|problema|ripresa[^:]{0,30}|decisione[^:]{0,25})\s*:\s*/i; // allow-italian: the prompts' own words, matched as data
const CLAUSE = /,\s+(?=(?:niente|non|senza|mai|nessun\w*|solo|sola|rispondi|in italiano|in inglese)\b)/i; // allow-italian: the prompts' own words, matched as data
const READ_ONLY = /\b(?:in\s+|di\s+)?sol[ao]\s+(?:lettura|scrittura)\b,?/gi; // allow-italian: the prompts' own words, matched as data
const SMALL = '(?:in|di|da|su|a|ad|al|nel|nella|del|della|con|per|sul|sulla|dal|dalla|e|o|il|lo|la|le|gli|i|un|una|uno|tra|fra)'; // allow-italian: the prompts' own words, matched as data
const TRAIL_WORDS = new RegExp(`\\s+${SMALL}\\s*$`, 'i');
const TRAIL_PLACE = new RegExp(`\\s+(?:${SMALL}\\s+){1,2}(?:worktree|repo|ramo|branch|cartella|progetto|file)\\s*$`, 'i'); // allow-italian: the prompts' own words, matched as data
const BROKEN = new RegExp(`(?:^|\\s)(?:${SMALL}|file|script|cartella|comando|ramo|percorso|branch)\\s*${CUT}`, 'i'); // allow-italian: the prompts' own words, matched as data
const ENDS_ON_VERB = /\s(?:è|e'|sono|sta|stanno|ha|hanno)$/i; // allow-italian: the prompts' own words, matched as data

/** The end of a sentence without what a removed token left: the mark, a dangling place, a dangling small word. */
function trimTail(s: string): string {
  let t = s;
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(new RegExp(`[\\s,;:.]*${CUT}[\\s,;:.]*$`), '').replace(TRAIL_PLACE, '').replace(TRAIL_WORDS, '').trim();
    if (t === before) break;
  }
  return t;
}

/**
 * Past a preamble the next sentences are as often the rules as the work: one
 * is a title only when it is hasLabel as the goal or opens on a verb of work.
 */
const ACTION = /^(?:\p{L}+(?:are|ere|ire)|correggi|verifica|crea|aggiungi|togli|sistema|rifai|porta|sposta|scrivi|leggi|prepara|trova|cerca|controlla|ripara|rilancia|chiudi|riprendi|completa|traduci|aggiorna|implementa|rimuovi|fai|prova|misura|studia|analizza|confronta|migra|collega|pubblica|rigenera|ricostruisci|indaga|rivedi|rileggi)\b/iu; // allow-italian: the prompts' own words, matched as data

/** One sentence of a prompt made a title, or '' when it is not one; null when it is a preamble to skip. */
function sentenceTitle(raw: string, afterPreamble: boolean): string | null {
  let t = raw.trim();
  if (!t) return null;
  if (WRAPPER.test(t) || CHECKER.test(t)) return '';
  if (LOCATION.test(t) && (t.includes(CUT) || /\bramo\b|\brepo\b|\bworktree\b/i.test(t.split(':')[0]!))) t = t.replace(LOCATION, '');
  else t = t.replace(LOCATION_BARE, '');
  if (!t.trim() || PREAMBLE.test(t) || ROLE.test(t) || RULE.test(t)) return null;
  const hasLabel = LABEL.test(t);
  t = t.replace(LABEL, '');
  if (afterPreamble && !hasLabel && !ACTION.test(t)) return null;
  if (WRAPPER.test(t)) return '';
  t = t.split(CLAUSE)[0]!.replace(READ_ONLY, ' ');
  const colon = t.indexOf(': ');
  if (colon > 0) {
    const head = t.slice(0, colon).trim();
    const tail = t.slice(colon + 2).replace(new RegExp(CUT, 'g'), '').trim();
    const words = head.split(/\s+/).length;
    if (!tail && words <= 3) return '';
    if (head.includes(CUT) && words <= 3) t = t.slice(colon + 2);
    else if (words >= 3) t = head;
  }
  // A path between a verb and the next one: «read X and tell me» reads «tell me».
  t = t.replace(new RegExp(`^[\\p{L}']+\\s*${CUT}\\s+e\\s+`, 'iu'), '');
  t = trimTail(t);
  // A path cut out of the middle leaves the sentence broken there: what comes before it may still read.
  const broken = BROKEN.exec(t);
  if (broken) t = trimTail(t.slice(0, broken.index));
  if (broken && t.split(/\s+/).length < 3) return '';
  t = t.replace(new RegExp(CUT, 'g'), ' ').replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/[.:,;]+$/, '').trim();
  t = t.replace(/^«(.*)»$/, '$1').replace(/^"(.*)"$/, '$1').trim();
  if (/^\d+[.)]/.test(t) || ENDS_ON_VERB.test(t)) return '';
  if (t.split(/\s+/).length < 2 || !/[a-zà-ý]{3}/i.test(t)) return '';
  if (looksEnglish(t)) return '';
  return clip(capFirst(t));
}

/**
 * The automation a job was sent to repair, by the name the hub gave it,
 * without the hub's notes in brackets and after the second colon; null for
 * any other job. The view words the repair.
 */
export function repairName(raw: unknown): string | null {
  const auto = /^Automazione «([^»]+)»/i.exec(typeof raw === 'string' ? raw.trim() : ''); // allow-italian: the hub's own prompt
  if (!auto) return null;
  const parts = auto[1]!.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim().split(/\s*:\s+/);
  const name = parts.length > 1 && parts[0]!.split(' ').length <= 2 ? `${parts[0]}: ${parts[1]}` : parts[0]!;
  return clip(name.trim(), TITLE_MAX - 10);
}

/**
 * The title of a delegated job, from the text it was given. A prompt is not
 * a title: it starts with where to work, who the agent is, the rules, and only
 * then the work. So the first sentence that says the work, without paths,
 * files, commands, links, parentheses, hashes or flags, at most 64
 * characters. '' when no sentence is readable on its own (a command wrapper,
 * a task kept in a file, a prompt in English, a sentence a removed path left
 * broken): the view then names the job by its project instead.
 */
export function jobTitle(raw: unknown): string {
  let s = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if (!s || s.startsWith('-')) return '';
  // A card of the board names itself between the quotes.
  const card = /^Card della board[^«]*«(.+?)»(?:\.|\s|$)/i.exec(s);
  if (card) return clip(capFirst(card[1]!.trim()));
  // An automation the hub sent to be repaired is named by `repairName`, not here.
  if (repairName(s)) return '';
  s = calm(s)
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\([^)]*$/, ' ')
    .replace(/`[^`]*`?/g, CUT)
    .replace(/https?:\/\/\S*[^\s.,;:)]/g, CUT)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, CUT)
    .replace(/(?<![\w/])(?:~|\.{1,2})?\/[^\s,;]*[^\s,;.:]/g, CUT)
    // A word/word of letters only is prose (rollback/redeploy); with a digit, a dash, a dot or a second slash it is a path or a branch.
    .replace(/\b(?![\p{L}]+\/[\p{L}]+\b(?![/\w-]|\.\w))[\w.-]*[a-z][\w.-]*\/[^\s,;]*[^\s,;.:]/giu, CUT)
    .replace(/\b[\w.-]+\.(?:jsonl?|mjs|cjs|js|ts|tsx|jsx|swift|rs|py|sh|md|txt|ya?ml|html|css|toml|lobster|jpe?g|png|webp|gif|svg|pdf|webm|mp4)\b/gi, CUT)
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, CUT)
    .replace(/\b\w+=\S+/g, CUT)
    .replace(/(?:^|\s)--?[a-z][\w-]*/g, ` ${CUT}`)
    .replace(/\s+/g, ' ');
  const sentences = s.split(/(?<=[.!?])\s+|\s[\u2014\u2013-]\s|;\s|\s(?=\d[.)]\s)/).slice(0, 5);
  let afterPreamble = false;
  for (const sentence of sentences) {
    const t = sentenceTitle(sentence, afterPreamble);
    if (t !== null) return t;
    afterPreamble = true;
  }
  return '';
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

interface WorkflowDetail { at: number; phases: WorkflowPhase[]; agents: number | null; durationMs: number | null }

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
      runs.push({ at, phases, agents: num(r.agents), durationMs: num(r.durationMs) });
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
      title,
      outcome,
      at,
      agents: run?.agents ?? said.agents,
      durationMs: run?.durationMs ?? said.durationMs,
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
      };
      const prev = byId.get(id);
      if (!prev || (row.endedAt ?? row.startedAt ?? 0) > (prev.endedAt ?? prev.startedAt ?? 0)) byId.set(id, row);
    }
    return [...byId.values()];
  };
  const live = pick(active, new Set());
  return { active: live, recent: pick(recent, new Set(live.map((s) => s.id))) };
}

/** Two rows read the same in the list: same words, same kind, same place, same model. */
function sameLabel(a: JobRow, b: JobRow): boolean {
  if (!(a.title || a.fallback || a.repairOf)) return false;
  return a.title === b.title && a.fallback === b.fallback && (a.repairOf ?? null) === (b.repairOf ?? null)
    && (a.channel ?? null) === (b.channel ?? null) && (a.project ?? null) === (b.project ?? null) && (a.model ?? null) === (b.model ?? null);
}

/** Consecutive rows that read the same, with the same tone, become one, counted (×N). */
export function foldRows(rows: JobRow[]): JobRow[] {
  const out: JobRow[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.tone === r.tone && last.source === r.source && !last.target && sameLabel(last, r)) {
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
  at: tone === 'you' ? r.since ?? null : null,
  question: tone === 'you' ? r.question ?? null : null,
  target: { kind: r.kind, id: r.id, name: r.label },
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
});

const queueRow = (q: QueueItem, tone: JobTone, at: number | null): JobRow => ({
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
});

const proxyRow = (s: ProxySession, tone: JobTone, at: number | null): JobRow => ({
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

  // RUNNING
  const running: JobSection[] = [
    ...section('topics', topics.working.map((r) => topicRow(r, 'live'))),
    ...section('proxy', proxyActive.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).map((s) => proxyRow(s, 'live', s.startedAt))),
    ...section('queue', queue.filter((q) => q.status === 'running').map((q) => queueRow(q, 'live', q.startedAt ?? q.createdAt))),
    ...section('workflows', flows.filter((w) => w.outcome === 'running').sort((a, b) => b.at - a.at).map((w) => workflowRow(w, 'live'))),
  ];

  // WAITING: yours first, then the line in the hub's own order, then the ones a quota holds.
  const queued = queue.filter((q) => q.status === 'queued');
  const held = queued.filter((q) => q.waitUntil !== null && q.waitUntil > now).sort((a, b) => (a.waitUntil ?? 0) - (b.waitUntil ?? 0));
  const line = queued.filter((q) => !(q.waitUntil !== null && q.waitUntil > now))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const lineItems = new Map(line.map((q) => [`queue:${q.id}`, q]));
  const lineRows = foldRows(line.map((q) => ({ ...queueRow(q, 'line', q.createdAt), cancelId: q.id })))
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
    ...section('quota', held.map((q) => ({ ...queueRow(q, 'quota', q.waitUntil), cancelId: q.id }))),
  ];

  // FINISHED: what failed on top, then today and yesterday.
  const ended: JobRow[] = [
    ...queue.filter((q) => (q.status === 'done' || q.status === 'failed') && (q.endedAt ?? q.createdAt) >= yesterday)
      .map((q) => queueRow(q, q.status === 'failed' ? 'failed' : 'ok', q.endedAt ?? q.createdAt)),
    ...proxyRecent.map((s) => proxyRow(s, 'ok', s.endedAt)),
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

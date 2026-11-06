/**
 * The scheme of one automation, step by step (`/api/hub/automations/graph`):
 * when it starts, what it reads, its steps, which model answered and why,
 * where it delivers, each with its outcome and time, and behind a fold what
 * it was asked, what it answered, its error and the exact command. The hub
 * builds it from the job's definition, its script and its log.
 *
 * Pure reads: no fetch, no React, no words. Ids of chats, groups and runs
 * never reach the page (`noIds`), as on the hub's own page.
 */
import { asRecord, list, num, str } from './automationsHead';

export type GraphOutcome = 'ok' | 'error' | 'skipped' | 'unused';

export interface GraphOption {
  exec: string | null;
  name: string | null;
  model: string | null;
  account: string | null;
  outcome: GraphOutcome | null;
  ms: number | null;
  tokens: number | null;
  note: string | null;
}

export interface GraphNode {
  id: string;
  kind: 'trigger' | 'sources' | 'step' | 'model' | 'deliver';
  label: string;
  params: Array<{ k: string; v: string }>;
  about: string | null;
  notes: string[];
  detail: string | null;
  items: Array<{ label: string; detail: string | null }>;
  outcome: GraphOutcome | null;
  /** The outcome was guessed from the run's, not logged for the step. */
  inferred: boolean;
  ms: number | null;
  at: number | null;
  asked: string | null;
  answered: string | null;
  answeredBy: string | null;
  error: string | null;
  command: string | null;
  options: GraphOption[];
  /** The gateway does not log which model of the queue answered. */
  whoUnknown: boolean;
}

export interface AutomationGraph {
  run: { at: number | null; ms: number | null; outcome: GraphOutcome | null };
  nodes: GraphNode[];
  from: string[];
}

/**
 * Free text without ids: WhatsApp groups, Discord channels, uuids and the
 * gateway's internal markers become nothing. `keepSpace` keeps the layout of
 * a command or an error.
 */
export function noIds(t: string, keepSpace = false): string {
  // The uuid goes first: its last group alone would read as a long number.
  const r = t
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    .replace(/<<<[A-Z_]*(?:>>>|…|\.\.\.)?/g, '')
    .replace(/\s*\((?:canale|channel|gruppo|group|chat|id)\s+[\d@a-z.:-]*\d{6,}[\d@a-z.:-]*\)/gi, '') // allow-italian: the hub's own words for a chat id, removed
    .replace(/\s+(?:con id|with id|channel|canale|chat|id)\s+\d{6,}(?:@[a-z.]+)?/gi, '') // allow-italian: idem
    .replace(/\b\d{12,}(?:@[a-z.]+)?/gi, '')
    .replace(/\b(account|conto|chat|utente|user)\s+\d{9,}/gi, '$1') // allow-italian: idem
    .replace(/\(\s*\)/g, '');
  return keepSpace ? r : r.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:)])(?=\s|$)/g, '$1').trim();
}

function outcomeOf(v: unknown): GraphOutcome | null {
  return v === 'ok' || v === 'error' || v === 'skipped' || v === 'unused' ? v : null;
}

const KINDS = new Set(['trigger', 'sources', 'step', 'model', 'deliver']);

function clean(v: unknown, keepSpace = false): string | null {
  const s = str(v);
  return s ? noIds(s, keepSpace) || null : null;
}

function readOption(v: unknown): GraphOption | null {
  const o = asRecord(v);
  if (!o) return null;
  return {
    exec: str(o.exec), name: str(o.name), model: str(o.model), account: str(o.account), outcome: outcomeOf(o.outcome),
    ms: num(o.ms), tokens: num(o.tokens), note: clean(o.note),
  };
}

function readNode(v: unknown): GraphNode | null {
  const n = asRecord(v);
  const kind = n?.kind;
  if (!n || typeof kind !== 'string' || !KINDS.has(kind)) return null;
  const io = asRecord(n.io) ?? {};
  const note = str(n.note);
  return {
    id: str(n.id) ?? kind,
    kind: kind as GraphNode['kind'],
    label: clean(n.label) ?? '',
    params: list(n.params).flatMap((p) => {
      const o = asRecord(p);
      const k = o && str(o.k);
      const val = o && str(o.v);
      return k && val ? [{ k, v: val }] : [];
    }),
    about: clean(n.about),
    notes: list(n.notes).flatMap((x) => {
      const t = clean(x);
      return t ? [t] : [];
    }),
    detail: clean(n.detail),
    items: list(n.items).flatMap((x) => {
      const o = asRecord(x);
      const label = o && str(o.label);
      return label ? [{ label, detail: str(o?.detail) }] : [];
    }),
    outcome: outcomeOf(n.outcome),
    inferred: n.inferred === true,
    ms: num(n.ms),
    at: num(n.at),
    asked: clean(io.in, true),
    answered: clean(io.out, true),
    answeredBy: str(io.outFrom),
    error: clean(n.error, true),
    command: str(n.command),
    options: list(n.options).flatMap((o) => {
      const x = readOption(o);
      return x ? [x] : [];
    }),
    whoUnknown: !!note && /non registra/.test(note),
  };
}

/** The hub's scheme of an automation, or null when there is none. */
export function readGraph(raw: unknown): AutomationGraph | null {
  const g = asRecord(raw);
  const nodes = list(g?.nodes).flatMap((n) => {
    const x = readNode(n);
    return x ? [x] : [];
  });
  if (!g || nodes.length === 0) return null;
  const run = asRecord(g.run) ?? {};
  return {
    run: { at: num(run.at), ms: num(run.ms), outcome: outcomeOf(run.outcome) },
    nodes,
    from: list(g.from).flatMap((f) => {
      const t = str(f);
      return t ? [t] : [];
    }),
  };
}

/**
 * Who answered in a model step, as the view tells it: the one that answered
 * (or most likely did, when the gateway does not log it), the ones tried
 * before it, and the ones that would have come after.
 */
export interface ModelStory {
  kind: 'answered' | 'likely' | 'noneAnswered' | 'unknown' | 'none';
  winner: GraphOption | null;
  before: GraphOption[];
  after: GraphOption[];
  tried: GraphOption[];
}

export function modelStory(n: Pick<GraphNode, 'options' | 'whoUnknown'>): ModelStory {
  const opts = n.options;
  const won = opts.findIndex((o) => o.outcome === 'ok');
  if (won === -1) {
    const tried = opts.filter((o) => o.outcome === 'error' || o.outcome === 'skipped');
    return { kind: tried.length ? 'noneAnswered' : opts.length ? 'unknown' : 'none', winner: null, before: [], after: opts.slice(1), tried };
  }
  return { kind: n.whoUnknown ? 'likely' : 'answered', winner: opts[won]!, before: opts.slice(0, won), after: opts.slice(won + 1), tried: [] };
}

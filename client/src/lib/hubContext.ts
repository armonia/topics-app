/**
 * THE AGENTS' CONTEXT, read from the usage hub (`/api/contesto`, HUBBR-17).
 *
 * What every agent reads before the first word: the weight per harness (Claude
 * Code, Codex, jcode, Jarvis), the files that make it, the sources read on
 * demand, the duplicated lines, the rules with an old date, and the hub's last
 * check for rules that contradict each other. Pure functions over the hub's
 * JSON (~/.claude/jarvis/tools/usage-hub/src/context.mjs): defensive, a field
 * the hub renamed is dropped, never thrown on.
 *
 * Names stay the hub's own labels («CLAUDE.md globale», «TOOLS.md»); a path is
 * shown only with a file's text, once opened, where it says where to edit it.
 */
import { MAIN_AGENT, agentName } from './agentSessions';
import { LEGACY_DATA_DIR_NAME } from '../../../shared/legacy-data-dir';

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface HarnessWeight {
  name: string;
  tokens: number;
  /** Tokens read on top of the base in some sessions only (the memory index in the sessions born in the home folder). */
  extra: { tokens: number; home: boolean } | null;
}

export interface ContextFile {
  id: string;
  label: string;
  /** The hub's key to read the text (`/api/context/text?path=`), shown with the text once opened. */
  path: string;
  group: string;
  tokens: number;
  /** Who reads it at start, by the hub's harness names; empty when it is read on demand. */
  readers: string[];
  /** The same, with the hub's qualifier kept (the home sessions' one for the memory index): the row's chips. */
  loaders: string[];
  /** Last change of the file (ms), null when the hub did not say. */
  mtime: number | null;
  /** The hub's own note, in its words (e.g. included from CLAUDE.md, read on demand). */
  note: string | null;
}

export interface RuleRef {
  /** The label of the file the rule is in. */
  where: string;
  text: string;
}

export interface ContextContradiction {
  why: string;
  a: RuleRef;
  b: RuleRef;
}

export interface ContextCheck {
  /** When the last check that answered ended (ms), null when none ever did. */
  at: number | null;
  running: boolean;
  /** Why the last check failed, in the hub's words. */
  error: string | null;
  items: ContextContradiction[];
}

export interface ContextView {
  at: number | null;
  harnesses: HarnessWeight[];
  /** The weight of Claude Code alone, the tail of the row in System. */
  claudeCode: number | null;
  /** Read at start by at least one harness. */
  files: ContextFile[];
  /** Read on demand: the sub-agents' prompts, the projects' CLAUDE.md, the other agents' memory and prompts. */
  onDemand: ContextFile[];
  /** The skills' listing; `items` heaviest first, the ones worth trimming. */
  skills: { count: number; tokens: number; items: Array<{ name: string; tokens: number }> } | null;
  duplicates: Array<{ text: string; where: string[] }>;
  /** `line` is where the rule sits in its file, to find it again; null when the hub did not say. */
  oldRules: Array<{ text: string; where: string; line: number | null; days: number }>;
  check: ContextCheck;
  doctor: DoctorVerdict | null;
}

/**
 * The verdict of agents-doctor, the hub's own checks. `pending` while the hub
 * is still running it (seconds to minutes after a restart): not green. `fail`
 * whenever the hub says not ok, a check fails or the doctor itself errored
 * (a timeout), even with no failing line to show.
 */
export interface DoctorVerdict {
  state: 'pending' | 'ok' | 'fail';
  total: number;
  failing: string[];
  /** The doctor's own error, in the hub's words («agents-doctor: timeout 30s»). */
  error: string | null;
}

export function doctorVerdict(raw: unknown): DoctorVerdict | null {
  if (!isObject(raw)) return null;
  const checks = list(raw.checks).filter(isObject);
  const failing = checks.filter((c) => c.ok === false).map((c) => str(c.text)).filter((s): s is string => s !== null);
  const error = str(raw.error);
  const failedCount = checks.filter((c) => c.ok === false).length;
  const state = raw.pending === true ? 'pending' : raw.ok === false || failedCount > 0 || error !== null ? 'fail' : 'ok';
  return { state, total: checks.length, failing, error };
}

/** The hub's loader groups, in its order; any other group follows in the order it first appears. */
const GROUP_ORDER = ['Claude Code', 'Codex e jcode', agentName(MAIN_AGENT)];

/**
 * The hub names our agent's harness by name plus workspace id («Jarvis ·
 * main», «Jarvis · gtm») or by name and qualifier («Jarvis (via claude)»). On screen
 * it is the agent's own name, the one the Agents view uses: `gtm` is Visione
 * there, so it is Visione here too, and a qualifier stays as it is.
 */
const AGENT_HARNESSES = new Set([agentName(MAIN_AGENT)]);
/** The workspace id of the main agent in the hub's labels. */
const MAIN_WORKSPACE = 'main';

function harnessName(name: string): string {
  const { base, note } = splitLoader(name);
  const ws = /^(.+?)\s+·\s+(.+)$/.exec(base);
  let alias: string | null = null;
  if (ws && ws[1] && ws[2] && AGENT_HARNESSES.has(ws[1])) alias = agentName(ws[2] === MAIN_WORKSPACE ? MAIN_AGENT : ws[2]);
  else if (AGENT_HARNESSES.has(base)) alias = agentName(MAIN_AGENT);
  if (alias === null) return name;
  return note === null ? alias : `${alias} (${note})`;
}

export interface FileGroup {
  name: string;
  files: ContextFile[];
  tokens: number;
}

export function fileGroups(files: ContextFile[]): FileGroup[] {
  const names = [...GROUP_ORDER, ...files.map((f) => f.group).filter((g) => !GROUP_ORDER.includes(g))];
  const out: FileGroup[] = [];
  for (const name of new Set(names)) {
    const fs = files.filter((f) => f.group === name);
    if (fs.length > 0) out.push({ name, files: fs, tokens: fs.reduce((a, f) => a + f.tokens, 0) });
  }
  return out;
}

/** Whole days since a file last changed; a file not touched for longer than STALE_FILE_DAYS is flagged. */
export const STALE_FILE_DAYS = 60;
export function fileAgeDays(mtime: number | null, now: number): number | null {
  return mtime === null ? null : Math.max(0, Math.floor((now - mtime) / 86_400_000));
}

/** "Name (qualifier)" -> base "Name", note "qualifier". */
function splitLoader(name: string): { base: string; note: string | null } {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(name);
  return m && m[1] ? { base: m[1], note: m[2] ?? null } : { base: name, note: null };
}

/**
 * One row per harness, heaviest first. A loader that only qualifies another
 * (Claude Code for the home sessions) is that harness's extra, not a fifth
 * harness; one that qualifies nothing else («Jarvis (via claude-cli)») is
 * the harness of its base name.
 */
export function harnessWeights(byLoader: unknown): HarnessWeight[] {
  if (!isObject(byLoader)) return [];
  const entries = Object.entries(byLoader)
    .map(([name, v]) => ({ name: harnessName(name), tokens: num(v) }))
    .filter((e): e is { name: string; tokens: number } => e.tokens !== null && e.tokens > 0);
  const plain = new Set(entries.filter((e) => splitLoader(e.name).note === null).map((e) => e.name));
  const out = new Map<string, HarnessWeight>();
  for (const e of entries) {
    const { base, note } = splitLoader(e.name);
    if (note === null || !plain.has(base)) {
      const prev = out.get(base);
      if (prev) prev.tokens = Math.max(prev.tokens, e.tokens);
      else out.set(base, { name: base, tokens: e.tokens, extra: null });
    }
  }
  for (const e of entries) {
    const { base, note } = splitLoader(e.name);
    const host = out.get(base);
    if (note === null || !plain.has(base) || !host) continue;
    // The hub sums only the files that loader adds (the memory index), not the base again.
    host.extra = { tokens: e.tokens + (host.extra?.tokens ?? 0), home: note.includes('~') };
  }
  return [...out.values()].sort((a, b) => b.tokens - a.tokens);
}

function readFile(raw: unknown): ContextFile | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const label = str(raw.label);
  const path = str(raw.path);
  if (!id || !label || !path) return null;
  return {
    id,
    label,
    path,
    group: harnessName(str(raw.group) ?? ''),
    tokens: num(raw.tokens) ?? 0,
    readers: [...new Set(list(raw.loaders).map(str).filter((s): s is string => s !== null).map((s) => splitLoader(harnessName(s)).base))],
    loaders: list(raw.loaders).map(str).filter((s): s is string => s !== null).map(harnessName),
    mtime: num(raw.mtime),
    note: str(raw.note),
  };
}

/** What an unlisted file is, from its path or id: the caller words it in the person's language. */
export interface UnlistedRef {
  kind: 'rules' | 'profile' | 'memory' | 'other';
  /** Whose file it is (a system or a project), empty when the path says nothing. */
  owner: string;
  /** The file's name without its extension, for `other`. */
  name: string;
}

const OWNERS: Record<string, string> = { '.claude': 'Claude Code', '.jcode': 'jcode', '.codex': 'Codex', '.agents': 'Agents' };
/** The agents' home: its files belong to the agent of their workspace (`workspace-gtm` is Visione). */
const AGENT_HOME = LEGACY_DATA_DIR_NAME;
const KINDS: Record<string, UnlistedRef['kind']> = { AGENTS: 'rules', CLAUDE: 'rules', USER: 'profile', MEMORY: 'memory' };

/**
 * The hub names a contradiction's files by path, and its lists do not hold
 * every file an agent may cite (the agents' workspaces): those are told apart by
 * whose they are, not shown as a bare file name that two files can share.
 */
export function unlistedRef(ref: string): UnlistedRef {
  const project = /^project:(.+)$/.exec(ref);
  if (project?.[1]) return { kind: 'rules', owner: project[1], name: '' };
  const parts = ref.replace(/^[^:/]*:(?!\/)/, '').split('/').filter((x) => x && x !== '~');
  const file = parts.pop() ?? ref;
  const name = file.replace(/\.[a-z0-9]+$/i, '');
  const root = parts[0] ?? '';
  let owner = '';
  if (root === 'Projects' && parts[1]) owner = parts[1];
  else if (root === AGENT_HOME) {
    const ws = parts[1] ? /^workspace-(.+)$/.exec(parts[1]) : null;
    owner = agentName(ws?.[1] ?? MAIN_AGENT);
  } else if (OWNERS[root]) {
    const ws = parts[1] && /^workspace-(.+)$/.exec(parts[1]);
    owner = ws && ws[1] ? `${OWNERS[root]} ${ws[1]}` : OWNERS[root];
  } else owner = parts[parts.length - 1] ?? '';
  return { kind: KINDS[name.toUpperCase()] ?? 'other', owner, name };
}

const defaultUnlisted = (u: UnlistedRef): string => [u.kind === 'other' ? u.name : u.kind, u.owner].filter(Boolean).join(' · ');

/** The label a file id or path stands for; `unlisted` words the ones the hub did not list. */
function labeller(files: ContextFile[], unlisted: (u: UnlistedRef) => string): (ref: string) => string {
  const byKey = new Map<string, string>();
  for (const f of files) { byKey.set(f.id, f.label); byKey.set(f.path, f.label); }
  return (ref) => byKey.get(ref) ?? unlisted(unlistedRef(ref));
}

/**
 * A rule line as plain words: the hub quotes the raw markdown line, so list
 * markers, headings, bold and code marks and a link's target (a file name)
 * would otherwise be on screen.
 */
export function plainRule(text: string): string {
  return text
    .replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    // The hub cuts long lines, which can leave a bold mark open.
    .replace(/\*\*/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A check marked running for longer than this is a leftover (the hub's own limit before it takes a new one). */
export const CHECK_STALE_MS = 20 * 60_000;

function readRule(raw: unknown, label: (ref: string) => string): RuleRef | null {
  if (!isObject(raw)) return null;
  const text = str(raw.text);
  const file = str(raw.file);
  return text ? { where: file ? label(file) : '', text: plainRule(text) } : null;
}

export function contextCheck(block: unknown, label: (ref: string) => string = (r) => r, now: number = Date.now()): ContextCheck {
  const b = isObject(block) ? block : {};
  const items: ContextContradiction[] = [];
  for (const raw of list(b.items)) {
    if (!isObject(raw)) continue;
    const why = str(raw.why);
    const a = readRule(raw.a, label);
    const bb = readRule(raw.b, label);
    if (why && a && bb) items.push({ why, a, b: bb });
  }
  // A hub restarted mid-check leaves running forever: like the hub, trust it only for 20 minutes.
  const startedAt = num(b.startedAt);
  const running = b.running === true && startedAt !== null && now - startedAt < CHECK_STALE_MS;
  return { at: num(b.at), running, error: str(b.error), items };
}

export function contextView(data: unknown, unlisted: (u: UnlistedRef) => string = defaultUnlisted, now: number = Date.now()): ContextView | null {
  if (!isObject(data)) return null;
  const files = list(data.files).map(readFile).filter((f): f is ContextFile => f !== null);
  const onDemand = [...list(data.subagentPrompts), ...list(data.otherSources)]
    .map(readFile).filter((f): f is ContextFile => f !== null);
  const label = labeller([...files, ...onDemand], unlisted);
  const harnesses = harnessWeights(isObject(data.totals) ? data.totals.byLoader : null);
  const skills = isObject(data.skills) && num(data.skills.count) !== null
    ? {
      count: num(data.skills.count) ?? 0,
      tokens: num(data.skills.tokens) ?? 0,
      items: list(data.skills.items).flatMap((s) => {
        const name = isObject(s) ? str(s.name) : null;
        return name ? [{ name, tokens: num((s as Raw).tokens) ?? 0 }] : [];
      }).sort((a, b) => b.tokens - a.tokens),
    }
    : null;
  const duplicates = list(data.duplicates).flatMap((raw) => {
    if (!isObject(raw)) return [];
    const text = str(raw.text) && plainRule(str(raw.text) ?? '');
    const where = list(raw.files).map(str).filter((s): s is string => s !== null).map(label);
    return text && where.length > 1 ? [{ text, where }] : [];
  });
  const oldRules = list(data.oldRules).flatMap((raw) => {
    if (!isObject(raw)) return [];
    const text = plainRule(str(raw.text) ?? '');
    const days = num(raw.days);
    const file = str(raw.file);
    return text && days !== null ? [{ text, where: file ? label(file) : '', line: num(raw.line), days }] : [];
  }).sort((a, b) => b.days - a.days);
  const doctor = doctorVerdict(data.doctor);
  return {
    at: num(data.at),
    harnesses,
    claudeCode: harnesses.find((h) => h.name === 'Claude Code')?.tokens ?? null,
    files,
    onDemand,
    skills,
    duplicates,
    oldRules,
    check: contextCheck(data.contradictions, label, now),
    doctor,
  };
}

/** «15 k» for 14.888, «950» under a thousand, in the person's locale. */
export function shortTokens(n: number, locale: string): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k.toLocaleString(locale === 'en' ? 'en-GB' : 'it-IT', { maximumFractionDigits: k < 10 ? 1 : 0 })} k`;
}

/** What the hub answered to «look for contradictions» (`POST /api/contesto/check`). */
export type CheckStart = { ok: true; already: boolean } | { ok: false; why: string };

export function checkStart(status: number, body: unknown): CheckStart {
  const b = isObject(body) ? body : {};
  if (status >= 200 && status < 300 && b.ok === true) return { ok: true, already: b.already === true };
  return { ok: false, why: str(b.error) ?? `HTTP ${status}` };
}

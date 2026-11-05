/**
 * THE AGENTS' CONTEXT, read from the usage hub (`/api/contesto`, HUBBR-17).
 *
 * What every agent reads before the first word: the weight per harness (Claude
 * Code, Codex, jcode, OpenClaw), the files that make it, the sources read on
 * demand, the duplicated lines, the rules with an old date, and the hub's last
 * check for rules that contradict each other. Pure functions over the hub's
 * JSON (~/.claude/jarvis/tools/usage-hub/src/context.mjs): defensive, a field
 * the hub renamed is dropped, never thrown on.
 *
 * Names stay the hub's own labels («CLAUDE.md globale», «TOOLS.md»); a path is
 * kept only to ask for a file's text, never to show.
 */

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
  /** The hub's key to read the text (`/api/context/text?path=`), never shown. */
  path: string;
  group: string;
  tokens: number;
  /** Who reads it at start, by the hub's harness names; empty when it is read on demand. */
  readers: string[];
  /** The hub's own note («incluso da CLAUDE.md», «letto su richiesta»). */
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
  /** Read on demand: the sub-agents' prompts, the projects' CLAUDE.md, OpenClaw's memory and prompts. */
  onDemand: ContextFile[];
  skills: { count: number; tokens: number } | null;
  duplicates: Array<{ text: string; where: string[] }>;
  oldRules: Array<{ text: string; where: string; days: number }>;
  check: ContextCheck;
  /** The hub of the agents' own checks: how many, and the ones that fail. */
  doctor: { total: number; failing: string[] } | null;
}

/** «Claude Code (sessioni nate in ~)» → base «Claude Code», note «sessioni nate in ~». */
function splitLoader(name: string): { base: string; note: string | null } {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(name);
  return m && m[1] ? { base: m[1], note: m[2] ?? null } : { base: name, note: null };
}

/**
 * One row per harness, heaviest first. A loader that only qualifies another
 * («Claude Code (sessioni nate in ~)») is that harness's extra, not a fifth
 * harness; one that qualifies nothing else («OpenClaw (via claude-cli)») is
 * the harness of its base name.
 */
export function harnessWeights(byLoader: unknown): HarnessWeight[] {
  if (!isObject(byLoader)) return [];
  const entries = Object.entries(byLoader)
    .map(([name, v]) => ({ name, tokens: num(v) }))
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
    group: str(raw.group) ?? '',
    tokens: num(raw.tokens) ?? 0,
    readers: list(raw.loaders).map(str).filter((s): s is string => s !== null).map((s) => splitLoader(s).base),
    note: str(raw.note),
  };
}

/** The label a file id or path stands for; the last piece of it when the hub did not list it. */
function labeller(files: ContextFile[]): (ref: string) => string {
  const byKey = new Map<string, string>();
  for (const f of files) { byKey.set(f.id, f.label); byKey.set(f.path, f.label); }
  return (ref) => byKey.get(ref) ?? ref.split(/[/:]/).filter(Boolean).pop() ?? ref;
}

function readRule(raw: unknown, label: (ref: string) => string): RuleRef | null {
  if (!isObject(raw)) return null;
  const text = str(raw.text);
  const file = str(raw.file);
  return text ? { where: file ? label(file) : '', text } : null;
}

export function contextCheck(block: unknown, label: (ref: string) => string = (r) => r): ContextCheck {
  const b = isObject(block) ? block : {};
  const items: ContextContradiction[] = [];
  for (const raw of list(b.items)) {
    if (!isObject(raw)) continue;
    const why = str(raw.why);
    const a = readRule(raw.a, label);
    const bb = readRule(raw.b, label);
    if (why && a && bb) items.push({ why, a, b: bb });
  }
  return { at: num(b.at), running: b.running === true, error: str(b.error), items };
}

export function contextView(data: unknown): ContextView | null {
  if (!isObject(data)) return null;
  const files = list(data.files).map(readFile).filter((f): f is ContextFile => f !== null);
  const onDemand = [...list(data.subagentPrompts), ...list(data.otherSources)]
    .map(readFile).filter((f): f is ContextFile => f !== null);
  const label = labeller([...files, ...onDemand]);
  const harnesses = harnessWeights(isObject(data.totals) ? data.totals.byLoader : null);
  const skills = isObject(data.skills) && num(data.skills.count) !== null
    ? { count: num(data.skills.count) ?? 0, tokens: num(data.skills.tokens) ?? 0 }
    : null;
  const duplicates = list(data.duplicates).flatMap((raw) => {
    if (!isObject(raw)) return [];
    const text = str(raw.text);
    const where = list(raw.files).map(str).filter((s): s is string => s !== null).map(label);
    return text && where.length > 1 ? [{ text, where }] : [];
  });
  const oldRules = list(data.oldRules).flatMap((raw) => {
    if (!isObject(raw)) return [];
    const text = str(raw.text);
    const days = num(raw.days);
    const file = str(raw.file);
    return text && days !== null ? [{ text, where: file ? label(file) : '', days }] : [];
  }).sort((a, b) => b.days - a.days);
  const doc = isObject(data.doctor) ? data.doctor : null;
  const checks = doc ? list(doc.checks).filter(isObject) : [];
  const doctor = doc
    ? { total: checks.length, failing: checks.filter((c) => c.ok === false).map((c) => str(c.text)).filter((s): s is string => s !== null) }
    : null;
  return {
    at: num(data.at),
    harnesses,
    claudeCode: harnesses.find((h) => h.name === 'Claude Code')?.tokens ?? null,
    files,
    onDemand,
    skills,
    duplicates,
    oldRules,
    check: contextCheck(data.contradictions, label),
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

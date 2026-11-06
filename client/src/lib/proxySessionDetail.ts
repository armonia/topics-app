/**
 * WHAT A SESSION OF THE CLAUDE PROXY IS DOING (hub-smistamento, HUBBR-13).
 *
 * The proxy (switchboard) keeps, for each session passing through it, the
 * tool it is running now, when it last asked something, the account it
 * spends, a timeline the proxy's summariser wrote, and the files two sessions
 * are editing at once. This module reads them in the level's own terms:
 *
 * - the tool at work as a verb (`Read README.md` reads «Legge README.md»),
 *   only the file's name, never a path, a command or its arguments;
 * - idle for more than two minutes is a session waiting for its next input,
 *   not one at work;
 * - the timeline keeps only the summariser's lines in Italian: the person's
 *   own input lines are the raw prompt, which the level never shows;
 * - the cost at the list price of the model, as the hub's page estimated it.
 *
 * Pure reads: no fetch, no React. The view formats every word.
 */
import { modelPrice } from '../../../shared/model-pricing';
import { clip, looksEnglish } from './jobTitle';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Past this silence a session of the proxy waits for its next input. */
export const PROXY_IDLE_MS = 2 * 60_000;

/** The proxy's tools, by the verb the level gives them (keys of `agentsJobs.act.*`). */
const TOOL_VERB: Record<string, string> = {
  read: 'read', write: 'write', edit: 'edit', multiedit: 'edit', notebookedit: 'edit',
  grep: 'grep', glob: 'glob', ls: 'ls', websearch: 'websearch', webfetch: 'webfetch',
  task: 'agent', agent: 'agent', todowrite: 'todo', bash: 'bash',
};
const FILE_TOOLS = new Set(['read', 'write', 'edit']);

export interface ProxyActivity {
  /** The verb, a key under `agentsJobs.act.`. */
  verb: string;
  /** The file's name, for the tools that touch one, when the proxy did not cut it. */
  file: string | null;
}

/** A file name without the path, or null when it carries an id (a hash, a uuid) or was cut. */
function fileName(arg: string): string | null {
  if (!arg || arg.endsWith('...') || arg.endsWith('…')) return null;
  const name = arg.split(/\s/)[0]!.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (!name || /[0-9a-f]{8,}/i.test(name) || name.length > 48) return null;
  return name;
}

/** The tool at work now, as a verb and a file name; null for a tool the level has no words for. */
export function proxyActivity(raw: unknown): ProxyActivity | null {
  const s = str(raw);
  if (!s) return null;
  const m = /^(\S+?):?\s+([\s\S]*)$/.exec(s) ?? [s, s, ''];
  const name = m[1]!.toLowerCase();
  if (name.startsWith('mcp__')) return { verb: 'mcp', file: null };
  const verb = TOOL_VERB[name];
  if (!verb) return null;
  return { verb, file: FILE_TOOLS.has(verb) ? fileName(m[2]!.trim()) : null };
}

/** The proxy's timestamp in front of a summary line («[2026-11-05 11:02]»). */
const STAMP = /^\[(?:[A-Z][a-z]{2} )?\d{4}-\d{2}-\d{2}[ T][\d:]+(?: ?GMT[+-]?\d*| ?UTC)?\]\s*/;

const TOOL_LINE = /^[\w-]+:\s/;

/**
 * The summariser's lines of a session, in Italian, oldest first: never an
 * input line (the person's prompt), never a line in English, never a path or a
 * command. At most `max`, the latest.
 */
export function proxyTimeline(segments: Record<string, unknown>[], max = 8): string[] {
  const out: string[] = [];
  for (const s of segments) {
    for (const t of Array.isArray(s.timeline) ? s.timeline : []) {
      if (!isObject(t) || t.type === 'input') continue;
      const text = str(t.text)?.replace(STAMP, '') ?? '';
      // A tool line («Bash: cd ...») is the command itself, not a summary of it.
      if (!text || TOOL_LINE.test(text) || text.split(/\s+/).length < 3 || looksEnglish(text) || /[\\/]\w|`|\$\s|https?:|^\[/.test(text)) continue;
      const line = clip(text, 140);
      if (out[out.length - 1] !== line) out.push(line);
    }
  }
  return out.slice(-max);
}

/** The session's cost at the list price of its model, in dollars; null for a model with no price. */
export function proxyCostUsd(model: unknown, inputTokens: unknown, outputTokens: unknown): number | null {
  const id = str(model);
  const price = id ? modelPrice(id) : null;
  if (!price) return null;
  return ((num(inputTokens) ?? 0) / 1e6) * price.input + ((num(outputTokens) ?? 0) / 1e6) * price.output;
}

export interface ProxyConflict {
  /** The file's name; the whole path stays in `path`, for the tooltip. */
  file: string;
  path: string;
  count: number;
}

/** The files more than one session of the proxy is editing at once. */
export function proxyConflicts(raw: unknown): ProxyConflict[] {
  const list = isObject(raw) && Array.isArray(raw.conflicts) ? raw.conflicts : [];
  return list.flatMap((c) => {
    if (!isObject(c)) return [];
    const path = str(c.file);
    const count = num(c.count);
    // A word the proxy parsed out of a command line («-n») is not a file.
    if (!path || path.startsWith('-') || count === null || count < 2) return [];
    return [{ file: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path, path, count }];
  });
}

/** The proxy's own state: answering, with its session monitor switched off, or not read. */
export type ProxyState = 'ok' | 'monitorOff' | 'silent';

export function proxyState(raw: unknown): ProxyState {
  if (!isObject(raw)) return 'silent';
  return raw.enabled === false ? 'monitorOff' : 'ok';
}

/**
 * Moved addresses. An edition lists them (`RedirectDef`); the container
 * resolves an address through them before it looks for the place: the old
 * address is replaced, once, by the one that took its content, and the screen
 * state the old one meant (a filter) is written on the way.
 */
import type { Params, RedirectDef } from './kit';

/** A redirect that points at another one is followed, but only this many times. */
export const MAX_REDIRECT_HOPS = 3;

export interface CompiledRedirect {
  def: RedirectDef;
  segments: string[];
}

export interface RedirectResult {
  /** Where the address finally lands. */
  path: string;
  /** The screen state to write, in the order the hops asked for it. */
  ui: Record<string, unknown>;
}

const split = (path: string) => path.split('/').filter(Boolean);

/** How many fixed segments a pattern has: `/da-fare/:flow` is 1, `/da-fare/kanban` is 2. (allow-italian: addresses) */
const staticSegments = (segments: string[]) => segments.filter((s) => !s.startsWith(':')).length;

/** More segments first, static before parameter: the most specific old address wins. */
function rank(segments: string[]): string {
  return `${String(99 - segments.length).padStart(2, '0')}${segments.map((s) => (s.startsWith(':') ? '1' : '0')).join('')}`;
}

export function compileRedirects(defs: RedirectDef[] = []): CompiledRedirect[] {
  return defs
    .map((def) => ({ def, segments: split(def.from) }))
    .sort((a, b) => rank(a.segments).localeCompare(rank(b.segments)));
}

function matchOne(table: CompiledRedirect[], path: string): { def: RedirectDef; params: Params; fixed: number } | null {
  let parts: string[];
  try {
    parts = split(path).map(decodeURIComponent);
  } catch {
    return null;
  }
  for (const { def, segments } of table) {
    if (segments.length !== parts.length) continue;
    const params: Params = {};
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = parts[i];
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { def, params, fixed: staticSegments(segments) };
  }
  return null;
}

/**
 * Where `path` lands after its redirects, or null when it was not moved.
 * `placeFixed(path)` says how many fixed segments the pattern of the place that
 * really draws `path` has (0 when none does): a place that is more specific than
 * the redirect keeps its address, so an old `/da-fare/:flow` never swallows the (allow-italian: addresses)
 * new `/da-fare/kanban`. On a tie the redirect wins. (allow-italian: addresses)
 */
export function resolveRedirect(table: CompiledRedirect[], path: string, placeFixed: (path: string) => number = () => 0): RedirectResult | null {
  let at = path;
  let ui: Record<string, unknown> = {};
  let moved = false;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const m = matchOne(table, at);
    if (!m || placeFixed(at) > m.fixed) break;
    ui = { ...ui, ...m.def.ui?.(m.params) };
    at = m.def.to(m.params);
    moved = true;
  }
  return moved ? { path: at, ui } : null;
}

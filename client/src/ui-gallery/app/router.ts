/**
 * Matching an address against the places of every area. Patterns are
 * compiled once; a static segment beats a parameter at the same position, so
 * `/flussi/nuovo` wins over `/flussi/:flow` whatever order the areas list them. (allow-italian: quotes the Italian interface)
 */
import type { Params, ScreenDef } from './kit';

interface Compiled {
  def: ScreenDef;
  segments: string[];
}

export interface Match {
  def: ScreenDef;
  params: Params;
}

const split = (path: string) => path.split('/').filter(Boolean);

/** Sort key: more segments first, then static segments earlier. */
function rank(segments: string[]): string {
  return `${String(99 - segments.length).padStart(2, '0')}${segments.map((s) => (s.startsWith(':') ? '1' : '0')).join('')}`;
}

export function compile(defs: ScreenDef[]): Compiled[] {
  return defs
    .map((def) => ({ def, segments: split(def.path) }))
    .sort((a, b) => rank(a.segments).localeCompare(rank(b.segments)));
}

export function match(table: Compiled[], path: string): Match | null {
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
    if (ok) return { def, params };
  }
  return null;
}

/** The path part of a hash: `#/pratiche/2418` → `/pratiche/2418`. */
export const pathOfHash = (hash: string) => {
  const p = hash.replace(/^#/, '');
  return p.startsWith('/') ? p : `/${p}`;
};

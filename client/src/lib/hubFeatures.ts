/**
 * THE FEATURE MAP, read from the usage hub (`/api/features`, HUBBR-18).
 *
 * The comparison between the agent systems: every leaf (a thing a system can
 * do) with who has it, Jarvis's own status, whether Jarvis is behind (it does
 * not have it fully and at least three others do) and the news the hub's
 * watcher found on it. Pure functions over the hub's JSON
 * (~/.claude/jarvis/tools/usage-hub/src/features.mjs): defensive, a field the
 * hub renamed is dropped, never thrown on.
 */

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The system the map measures against the others. */
export const OURS = 'jarvis';

export type LeafStatus = 'yes' | 'partial' | 'no' | 'unknown';
const STATUSES: readonly string[] = ['yes', 'partial', 'no', 'unknown'];
const statusOf = (v: unknown): LeafStatus => (STATUSES.includes(String(v)) ? (v as LeafStatus) : 'unknown');

export interface FeatureSystem {
  id: string;
  name: string;
  /** Share of the known leaves it covers, null when none is known. */
  pct: number | null;
  /** Its place in the ranking, from 1. */
  rank: number | null;
}

export interface FeatureNews {
  title: string;
  url: string | null;
  at: number | null;
  /** Where the watcher saw it (a repository or a changelog). */
  source: string;
}

export interface FeatureLeaf {
  id: string;
  name: string;
  desc: string;
  /** The group inside its area («Chat platforms»). */
  group: string;
  ours: LeafStatus;
  /** How many of the others have it fully, out of how many. */
  have: number;
  of: number;
  behind: boolean;
  /** The names of the others that have it fully, and in part. */
  withIt: string[];
  partly: string[];
  news: FeatureNews[];
  keywords: string[];
}

export interface FeatureArea {
  id: string;
  name: string;
  leaves: FeatureLeaf[];
  behind: number;
  /** Jarvis's share and place in this area. */
  oursPct: number | null;
  oursRank: number | null;
}

export interface FeaturesView {
  /** The day the map was last researched («2026-11-03»). */
  updated: string | null;
  systems: FeatureSystem[];
  leaves: number;
  behind: number;
  ours: FeatureSystem | null;
  areas: FeatureArea[];
}

/** «Jarvis (jarvis-channels)» → «Jarvis»: the repository in brackets is not a name. */
export function systemName(raw: unknown, id: string): string {
  const s = str(raw) ?? id;
  return s.replace(/\s*\([^)]*\)\s*$/, '') || s;
}

function safeUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function ranking(raw: unknown): Map<string, { pct: number; rank: number }> {
  const out = new Map<string, { pct: number; rank: number }>();
  list(raw).forEach((r, i) => {
    if (!isObject(r)) return;
    const id = str(r.id);
    const pct = num(r.pct);
    if (id && pct !== null) out.set(id, { pct, rank: i + 1 });
  });
  return out;
}

export function featuresView(data: unknown): FeaturesView | null {
  if (!isObject(data) || !Array.isArray(data.areas)) return null;
  const names = new Map<string, string>();
  for (const s of list(data.systems)) {
    if (!isObject(s)) continue;
    const id = str(s.id);
    if (id) names.set(id, systemName(s.name, id));
  }
  const nameOf = (id: string) => names.get(id) ?? id;
  const overall = ranking(data.ranking);
  const systems: FeatureSystem[] = [...names.keys()]
    .map((id) => ({ id, name: nameOf(id), pct: overall.get(id)?.pct ?? null, rank: overall.get(id)?.rank ?? null }))
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  const areas: FeatureArea[] = [];
  for (const a of list(data.areas)) {
    if (!isObject(a)) continue;
    const id = str(a.id);
    const name = str(a.name);
    if (!id || !name) continue;
    const leaves: FeatureLeaf[] = [];
    for (const g of list(a.children)) {
      if (!isObject(g)) continue;
      const group = str(g.name) ?? '';
      for (const l of list(g.children)) {
        if (!isObject(l)) continue;
        const lid = str(l.id);
        const lname = str(l.name);
        if (!lid || !lname) continue;
        const status = isObject(l.status) ? l.status : {};
        const others = Object.keys(status).filter((k) => k !== OURS);
        leaves.push({
          id: lid,
          name: lname,
          desc: str(l.desc) ?? '',
          group,
          ours: statusOf(l.ours ?? status[OURS]),
          have: num(l.have) ?? others.filter((k) => status[k] === 'yes').length,
          of: num(l.of) ?? others.length,
          behind: l.behind === true,
          withIt: others.filter((k) => status[k] === 'yes').map(nameOf),
          partly: others.filter((k) => status[k] === 'partial').map(nameOf),
          news: list(l.news).flatMap((n) => {
            if (!isObject(n)) return [];
            const title = str(n.title);
            if (!title) return [];
            const at = str(n.date) ? Date.parse(String(n.date)) : NaN;
            return [{ title, url: safeUrl(n.url), at: Number.isFinite(at) ? at : null, source: str(n.system) ?? '' }];
          }),
          keywords: list(l.keywords).map(str).filter((s): s is string => s !== null),
        });
      }
    }
    const mine = ranking(a.ranking).get(OURS);
    areas.push({ id, name, leaves, behind: leaves.filter((l) => l.behind).length, oursPct: mine?.pct ?? null, oursRank: mine?.rank ?? null });
  }
  const totals = isObject(data.totals) ? data.totals : {};
  const all = areas.flatMap((a) => a.leaves);
  const meta = isObject(data.meta) ? data.meta : {};
  return {
    updated: str(meta.updated),
    systems,
    leaves: num(totals.leaves) ?? all.length,
    behind: num(totals.behind) ?? all.filter((l) => l.behind).length,
    ours: systems.find((s) => s.id === OURS) ?? null,
    areas,
  };
}

export type FeatureFilter = 'behind' | 'all';

/** The areas with the leaves the filter and the search keep; an area left empty goes. */
export function visibleAreas(view: FeaturesView, filter: FeatureFilter, query: string): FeatureArea[] {
  const q = query.trim().toLowerCase();
  const hit = (l: FeatureLeaf) => !q || [l.name, l.desc, l.group, ...l.keywords].some((s) => s.toLowerCase().includes(q));
  return view.areas
    .map((a) => ({ ...a, leaves: a.leaves.filter((l) => (filter === 'all' || l.behind) && hit(l)) }))
    .filter((a) => a.leaves.length > 0);
}

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
  /** Who it comes from: a system's name, or the repository's own name. */
  source: string;
}

/** What was decided about a feature Jarvis does not fully have (`plan` in the hub's map). */
export type PlanKind = 'sviluppo' | 'topics' | 'altro' | 'scelta' | 'fatto'; // allow-italian: the hub's own keys, compared by value
const PLAN_KINDS: readonly string[] = ['sviluppo', 'topics', 'altro', 'scelta', 'fatto']; // allow-italian: the hub's own keys, compared by value

export interface FeaturePlan {
  kind: PlanKind;
  /** Priority of a feature still to build, 1 first. */
  prio: number | null;
  why: string;
}

/** One of the other systems on a feature: its name and its status there. */
export interface FeatureCell {
  name: string;
  status: LeafStatus;
}

export interface FeatureLeaf {
  id: string;
  name: string;
  desc: string;
  /** The group inside its area («Chat platforms») and its id. */
  group: string;
  groupId: string;
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
  /** How Jarvis actually does it, when the map says. */
  note: string | null;
  plan: FeaturePlan | null;
  /** Every other system with its status, who has it first, unknown last. */
  cells: FeatureCell[];
  /** The evidence pages behind the judgement, safe links only. */
  sources: string[];
}

export interface FeatureGroup {
  id: string;
  name: string;
  /** Jarvis's share in the group. */
  oursPct: number | null;
}

export interface FeatureArea {
  id: string;
  name: string;
  leaves: FeatureLeaf[];
  behind: number;
  /** Jarvis's share and place in this area. */
  oursPct: number | null;
  oursRank: number | null;
  /** The best of the others in this area, to say who is ahead and by how much. */
  best: { name: string; pct: number; rank: number } | null;
  groups: FeatureGroup[];
}

export interface FeaturesView {
  /** The day the map was last researched («2026-11-03»). */
  updated: string | null;
  /** When the watcher last looked for news (ISO), not when Topics read the hub. */
  checked: string | null;
  /** Features with news still to review. */
  withNews: number;
  /** How many features carry each decision. */
  plans: Record<PlanKind, number>;
  /** The features still to build, by priority. */
  todo: FeatureLeaf[];
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

/** The hub's own name for a source, else «HKUDS/nanobot» → «nanobot»: who the news is from, readable. */
function sourceName(raw: string | null, names: Map<string, string>): string {
  if (!raw) return '';
  return names.get(raw) ?? raw.split('/').pop() ?? raw;
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

function planOf(raw: unknown): FeaturePlan | null {
  if (!isObject(raw) || !PLAN_KINDS.includes(String(raw.kind))) return null;
  return { kind: raw.kind as PlanKind, prio: num(raw.prio), why: str(raw.why) ?? '' };
}

const CELL_ORDER: Record<LeafStatus, number> = { yes: 0, partial: 1, no: 2, unknown: 3 };

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
  const order = new Map(systems.map((s, i) => [s.id, i]));
  const rivals = systems.filter((s) => s.id !== OURS);
  const areas: FeatureArea[] = [];
  for (const a of list(data.areas)) {
    if (!isObject(a)) continue;
    const id = str(a.id);
    const name = str(a.name);
    if (!id || !name) continue;
    const leaves: FeatureLeaf[] = [];
    const groups: FeatureGroup[] = [];
    for (const g of list(a.children)) {
      if (!isObject(g)) continue;
      const group = str(g.name) ?? '';
      const groupId = str(g.id) ?? '';
      groups.push({ id: groupId, name: group, oursPct: ranking(g.ranking).get(OURS)?.pct ?? null });
      for (const l of list(g.children)) {
        if (!isObject(l)) continue;
        const leafId = str(l.id);
        const leafName = str(l.name);
        if (!leafId || !leafName) continue;
        const status = isObject(l.status) ? l.status : {};
        const others = Object.keys(status).filter((k) => k !== OURS);
        leaves.push({
          id: leafId,
          name: leafName,
          desc: str(l.desc) ?? '',
          group,
          groupId,
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
            return [{ title, url: safeUrl(n.url), at: Number.isFinite(at) ? at : null, source: sourceName(str(n.system), names) }];
          }),
          keywords: list(l.keywords).map(str).filter((s): s is string => s !== null),
          note: str(l.note),
          plan: planOf(l.plan),
          cells: rivals
            .map((s) => ({ id: s.id, name: s.name, status: statusOf(status[s.id]) }))
            .sort((x, y) => CELL_ORDER[x.status] - CELL_ORDER[y.status] || (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0))
            .map(({ name: n, status: st }) => ({ name: n, status: st })),
          sources: list(l.sources).map(safeUrl).filter((u): u is string => u !== null),
        });
      }
    }
    const inArea = ranking(a.ranking);
    const mine = inArea.get(OURS);
    const top = [...inArea].find(([k]) => k !== OURS);
    areas.push({
      id, name, leaves, groups,
      behind: leaves.filter((l) => l.behind).length,
      oursPct: mine?.pct ?? null,
      oursRank: mine?.rank ?? null,
      best: top ? { name: nameOf(top[0]), pct: top[1].pct, rank: top[1].rank } : null,
    });
  }
  const totals = isObject(data.totals) ? data.totals : {};
  const all = areas.flatMap((a) => a.leaves);
  const meta = isObject(data.meta) ? data.meta : {};
  const plans: Record<PlanKind, number> = { sviluppo: 0, topics: 0, altro: 0, scelta: 0, fatto: 0 };
  for (const l of all) if (l.plan) plans[l.plan.kind] += 1;
  return {
    updated: str(meta.updated),
    checked: str(meta.checked),
    withNews: num(totals.withNews) ?? all.filter((l) => l.news.length > 0).length,
    plans,
    todo: all.filter((l) => l.plan?.kind === 'sviluppo').sort((x, y) => (x.plan?.prio ?? 99) - (y.plan?.prio ?? 99)),
    systems,
    leaves: num(totals.leaves) ?? all.length,
    behind: num(totals.behind) ?? all.filter((l) => l.behind).length,
    ours: systems.find((s) => s.id === OURS) ?? null,
    areas,
  };
}

/** The words of the map in another language, keyed as `i18n-features-names-it.ts` is. */
export type FeatureWordsMap = Record<string, readonly [name: string, desc?: string]>;

/**
 * The map in the reader's language. The hub writes it in English; a word list
 * keyed by the hub's ids swaps area, group and feature names and descriptions.
 * An id it does not know keeps the hub's English. The English words move to
 * the keywords, so a search in either language still finds the feature.
 */
export function localizeFeatures(view: FeaturesView, words: FeatureWordsMap | null): FeaturesView {
  if (!words) return view;
  const areas = view.areas.map((a) => ({
    ...a,
    name: words[`a:${a.id}`]?.[0] ?? a.name,
    groups: a.groups.map((g) => ({ ...g, name: words[`g:${g.id}`]?.[0] ?? g.name })),
    leaves: a.leaves.map((l) => {
      const own = words[l.id];
      const group = words[`g:${l.groupId}`]?.[0] ?? l.group;
      if (!own && group === l.group) return l;
      return {
        ...l,
        name: own?.[0] ?? l.name,
        desc: own ? (own[1] ?? '') : l.desc,
        group,
        keywords: [...l.keywords, l.name, l.desc, l.group].filter((k) => k !== ''),
      };
    }),
  }));
  // The to-do list holds the same leaves: it reads them in the same language.
  const byId = new Map(areas.flatMap((a) => a.leaves).map((l) => [l.id, l]));
  return { ...view, areas, todo: view.todo.map((l) => byId.get(l.id) ?? l) };
}

/** Behind, all, with news to review, still to build, chosen not to do now. */
export type FeatureFilter = 'behind' | 'all' | 'news' | 'todo' | 'choice';
export const FEATURE_FILTERS: readonly FeatureFilter[] = ['behind', 'all', 'news', 'todo', 'choice'];

/** Whether a leaf passes a filter, before the search. */
export function passes(l: FeatureLeaf, filter: FeatureFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'behind': return l.behind;
    case 'news': return l.news.length > 0;
    case 'todo': return l.plan?.kind === 'sviluppo';
    case 'choice': return l.plan?.kind === 'scelta';
  }
}

/** How many leaves each filter keeps, for the counts on its tab. */
export function filterCounts(view: FeaturesView): Record<FeatureFilter, number> {
  return {
    behind: view.behind,
    all: view.leaves,
    news: view.withNews,
    todo: view.plans.sviluppo,
    choice: view.plans.scelta,
  };
}

/** The areas with the leaves the filter and the search keep; an area left empty goes. */
export function visibleAreas(view: FeaturesView, filter: FeatureFilter, query: string): FeatureArea[] {
  const q = query.trim().toLowerCase();
  const hit = (l: FeatureLeaf) => !q || [l.name, l.desc, l.group, ...l.keywords].some((s) => s.toLowerCase().includes(q));
  return view.areas
    .map((a) => ({ ...a, leaves: a.leaves.filter((l) => passes(l, filter) && hit(l)) }))
    .filter((a) => a.leaves.length > 0);
}

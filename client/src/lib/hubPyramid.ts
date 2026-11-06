/**
 * THE PYRAMID OF WHAT JARVIS NEEDS, read from the usage hub (`pyramid` inside
 * `/api/features`, HUBBR-18).
 *
 * Seven levels, from the channels the messages come from up to what the user
 * sees and who may do what; every function Jarvis needs with its outcome: covered,
 * done today, covered another way, moving to the single engine, partial,
 * missing, let go, to withdraw. Pure functions over the hub's JSON
 * (~/.claude/jarvis/features/pyramid.json): a field the hub renamed is
 * dropped, never thrown on.
 */

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export type PyramidStatus = 'ok' | 'fatto' | 'altro' | 'motore' | 'part' | 'no' | 'lascia' | 'ritira'; // allow-italian: the hub's own keys, compared by value
const STATUSES: readonly string[] = ['ok', 'fatto', 'altro', 'motore', 'part', 'no', 'lascia', 'ritira']; // allow-italian: the hub's own keys, compared by value

/** The four colours of a level's bar: covered, moving or partial, missing, not needed. */
export type PyramidBand = 'ok' | 'warn' | 'bad' | 'off';
export const PYRAMID_BANDS: readonly PyramidBand[] = ['ok', 'warn', 'bad', 'off'];

export const BAND_OF: Record<PyramidStatus, PyramidBand> = {
  ok: 'ok', fatto: 'ok', altro: 'ok', motore: 'warn', part: 'warn', no: 'bad', lascia: 'off', ritira: 'off',
};

/** Inside a level, what moved or is still open comes first, the covered last. */
const ORDER: Record<PyramidStatus, number> = { fatto: 0, motore: 1, part: 1, no: 1, altro: 2, lascia: 3, ritira: 3, ok: 4 };

export interface PyramidItem {
  name: string;
  status: PyramidStatus;
  /** What came of it (moved to the single engine, say), when the map says. */
  outcome: string | null;
  /** Where it lives in the code or in the configuration. */
  where: string | null;
  /** Its real use over the last fourteen days («36 turni»), null when not measured. */
  use: string | null;
}

export type BandCounts = Record<PyramidBand, number>;

export interface PyramidLevel {
  n: number;
  name: string;
  desc: string;
  items: PyramidItem[];
  counts: BandCounts;
  /** Functions this level needs (all but the ones let go) and how many are covered. */
  needed: number;
  covered: number;
}

export interface PyramidView {
  updated: string | null;
  /** From the top (the last level) to the base: the order it is drawn in. */
  levels: PyramidLevel[];
  needed: number;
  covered: number;
  doneToday: number;
  /** Moving to the single engine or partial. */
  moving: number;
  missing: number;
  /** Let go or to withdraw. */
  dropped: number;
}

/** A measure the map left as a dash or a question mark is no measure. */
function useOf(v: unknown): string | null {
  const s = str(v);
  return s && s !== '\u2014' && s !== '-' && s !== '?' ? s : null;
}

function countBands(items: PyramidItem[]): BandCounts {
  const c: BandCounts = { ok: 0, warn: 0, bad: 0, off: 0 };
  for (const i of items) c[BAND_OF[i.status]] += 1;
  return c;
}

export function pyramidView(data: unknown): PyramidView | null {
  if (!isObject(data)) return null;
  const levels: PyramidLevel[] = [];
  for (const l of list(data.levels)) {
    if (!isObject(l)) continue;
    const name = str(l.name);
    const n = typeof l.n === 'number' && Number.isFinite(l.n) ? l.n : levels.length + 1;
    if (!name) continue;
    const items: PyramidItem[] = list(l.items).flatMap((i) => {
      if (!isObject(i)) return [];
      const itemName = str(i.name);
      if (!itemName) return [];
      // A status the pyramid does not know reads as partial, as the hub draws it.
      const status = STATUSES.includes(String(i.status)) ? (i.status as PyramidStatus) : 'part';
      return [{ name: itemName, status, outcome: str(i.outcome), where: str(i.where), use: useOf(i.use) }];
    });
    items.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    const counts = countBands(items);
    levels.push({ n, name, desc: str(l.desc) ?? '', items, counts, needed: items.length - counts.off, covered: counts.ok });
  }
  if (levels.length === 0) return null;
  const all = levels.flatMap((l) => l.items);
  const total = countBands(all);
  return {
    updated: str(data.updated),
    levels: [...levels].sort((a, b) => b.n - a.n),
    needed: all.length - total.off,
    covered: total.ok,
    doneToday: all.filter((i) => i.status === 'fatto').length, // allow-italian: the hub's own keys, compared by value
    moving: total.warn,
    missing: total.bad,
    dropped: total.off,
  };
}

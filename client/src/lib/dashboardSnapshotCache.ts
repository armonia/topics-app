/**
 * THE NUMBERS OF THE DASHBOARD YOU LAST LOOKED AT, kept locally.
 *
 * The dashboard was the last pane that still made the reader watch it boot: its
 * body renders a centred spinner while `loading && !kpis`, and both of those
 * only clear when two fetches (`/dashboard/kpis` and `/dashboard/timeseries`)
 * have answered. Until then the pane is one small icon in the middle of an
 * empty rectangle, and then the whole layout - eight KPI cards and a 200px
 * chart - appears in one frame. That is a layout shift already made, and the
 * inventory in `docs/pane-first-frame-inventory.md` had it as the one row still
 * marked open.
 *
 * The copy is a SEED, not an authority: the fetch leaves in the same tick and
 * overwrites it as soon as it answers, so numbers computed on another window
 * never stick. What the seed buys is the FIRST FRAME, drawn with the geometry
 * the reader left behind.
 *
 * THE SELECTION TRAVELS WITH THE NUMBERS. A series is only meaningful next to
 * the metric and the range it was drawn for, so the snapshot carries both and
 * restores them: seeding a `tokens` chart into a pane that has reset itself to
 * `throughput` would be a wrong first frame, which is worse than an empty one.
 *
 * The point cap is about the viewport, not the truth: 400 points is more than
 * any range this selector offers, and it stops an unbounded series from being
 * written back on every refresh.
 */
import type { DashboardKPIs, TimeSeriesPoint } from './api';

const KEY = 'dashboard-snapshot-cache';
const MAX_POINTS = 400;

export interface DashboardSnapshot {
  metric: string;
  range: string;
  kpis: DashboardKPIs;
  points: TimeSeriesPoint[];
}

function isKpis(v: unknown): v is DashboardKPIs {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  // One numeric field is enough to tell a KPI payload from whatever else ended
  // up under the key: the shape is ours and it is versioned by this check, not
  // by a schema library the client does not otherwise need.
  return typeof o.throughputDay === 'number' && typeof o.wipCount === 'number';
}

function isPoint(v: unknown): v is TimeSeriesPoint {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.date === 'string' && typeof o.value === 'number';
}

/**
 * The half that can be wrong, kept away from the storage so it can be tested.
 *
 * Anything that is not a snapshot this build understands comes back as `null`,
 * and `null` means "draw the empty geometry": a seed half-read is worse than no
 * seed, because it puts a number on screen that nothing will ever correct.
 */
export function parseDashboardSnapshot(raw: string | null): DashboardSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.metric !== 'string' || typeof o.range !== 'string') return null;
    if (!isKpis(o.kpis)) return null;
    const points = Array.isArray(o.points) ? o.points.filter(isPoint) : [];
    return { metric: o.metric, range: o.range, kpis: o.kpis, points };
  } catch {
    return null;
  }
}

export function readDashboardSnapshot(): DashboardSnapshot | null {
  try {
    return parseDashboardSnapshot(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** What goes on the wire to storage, capped. Separated for the same reason. */
export function serializeDashboardSnapshot(snapshot: DashboardSnapshot): string {
  return JSON.stringify({ ...snapshot, points: snapshot.points.slice(-MAX_POINTS) });
}

export function writeDashboardSnapshot(snapshot: DashboardSnapshot): void {
  try {
    localStorage.setItem(KEY, serializeDashboardSnapshot(snapshot));
  } catch {
    /* quota, private mode: the seed is an optimisation, never a requirement */
  }
}

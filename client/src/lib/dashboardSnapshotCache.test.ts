/**
 * The dashboard's local seed: what may be drawn on the first frame.
 *
 * The seed exists so the pane is not an empty rectangle until two fetches
 * answer. That makes the parser the piece that can hurt: everything it accepts
 * is painted as fact before any server has confirmed it, and everything it
 * accepts HALF is painted as a number nothing will ever correct. So the tests
 * fix the two directions - a round trip survives, and a payload from another
 * shape is refused whole rather than repaired.
 *
 * @covers PERF-01
 */
import { describe, expect, test } from 'bun:test';
import {
  parseDashboardSnapshot,
  serializeDashboardSnapshot,
  type DashboardSnapshot,
} from './dashboardSnapshotCache';
import type { DashboardKPIs } from './api';

const KPIS: DashboardKPIs = {
  throughputDay: 3,
  throughputWeek: 11,
  avgCycleTimeHours: 2.5,
  wipCount: 4,
  errorRate: 0.02,
  tokenSpendDay: 1.23,
  tokenSpendWeek: 9.87,
  approvalTurnaroundHours: 1.5,
  pendingApprovals: 2,
};

const SNAPSHOT: DashboardSnapshot = {
  metric: 'tokens',
  range: '30d',
  kpis: KPIS,
  points: [
    { date: '2026-09-01', value: 1 },
    { date: '2026-09-02', value: 2 },
  ],
};

describe('dashboard snapshot, round trip', () => {
  test('the numbers and the selection come back together', () => {
    const back = parseDashboardSnapshot(serializeDashboardSnapshot(SNAPSHOT));
    expect(back).toEqual(SNAPSHOT);
  });

  test('the series is capped, and it is the TAIL that survives', () => {
    const points = Array.from({ length: 500 }, (_, i) => ({ date: `d${i}`, value: i }));
    const back = parseDashboardSnapshot(serializeDashboardSnapshot({ ...SNAPSHOT, points }));
    expect(back?.points.length).toBe(400);
    // The chart reads left to right and ends at now: dropping the newest points
    // would seed a chart that stops before the day the reader is looking at.
    expect(back?.points.at(-1)?.value).toBe(499);
  });
});

describe('dashboard snapshot, what is refused', () => {
  test('nothing stored is not a seed', () => {
    expect(parseDashboardSnapshot(null)).toBeNull();
    expect(parseDashboardSnapshot('')).toBeNull();
  });

  test('not JSON at all', () => {
    expect(parseDashboardSnapshot('{oops')).toBeNull();
  });

  test('KPIs from another shape are refused whole, not patched', () => {
    const raw = JSON.stringify({ metric: 'cost', range: '7d', kpis: { throughputDay: 3 }, points: [] });
    expect(parseDashboardSnapshot(raw)).toBeNull();
  });

  test('a series without its selection is not a series', () => {
    const raw = JSON.stringify({ kpis: KPIS, points: [{ date: 'd', value: 1 }] });
    expect(parseDashboardSnapshot(raw)).toBeNull();
  });

  test('a broken point is dropped, the snapshot survives', () => {
    const raw = JSON.stringify({
      metric: 'cost',
      range: '1d',
      kpis: KPIS,
      points: [{ date: 'd0', value: 1 }, { date: 'd1' }, null, { date: 'd2', value: 3 }],
    });
    expect(parseDashboardSnapshot(raw)?.points).toEqual([
      { date: 'd0', value: 1 },
      { date: 'd2', value: 3 },
    ]);
  });
});

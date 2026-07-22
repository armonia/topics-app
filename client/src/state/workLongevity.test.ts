import { describe, expect, it } from 'bun:test';
import {
  deriveWorkLongevity,
  formatElapsedCompact,
  WORK_ELAPSED_AFTER_MS,
  WORK_STALE_AFTER_MS,
} from './workLongevity';

const NOW = 1_700_000_000_000;

describe('deriveWorkLongevity', () => {
  it('a just-updated turn shows nothing (bare spinner)', () => {
    const r = deriveWorkLongevity(NOW - 5_000, NOW);
    expect(r.showElapsed).toBe(false);
    expect(r.isStale).toBe(false);
    expect(r.elapsedMs).toBe(5_000);
  });

  it('shows the "agg. Xm fa" readout at the elapsed threshold, still not stale', () => {
    const r = deriveWorkLongevity(NOW - WORK_ELAPSED_AFTER_MS, NOW);
    expect(r.showElapsed).toBe(true);
    expect(r.isStale).toBe(false);
  });

  it('just under the elapsed threshold stays bare', () => {
    const r = deriveWorkLongevity(NOW - (WORK_ELAPSED_AFTER_MS - 1), NOW);
    expect(r.showElapsed).toBe(false);
  });

  it('escalates to stale at the stale threshold', () => {
    const r = deriveWorkLongevity(NOW - WORK_STALE_AFTER_MS, NOW);
    expect(r.showElapsed).toBe(true);
    expect(r.isStale).toBe(true);
  });

  it('18 minutes with no update is stale', () => {
    const r = deriveWorkLongevity(NOW - 18 * 60_000, NOW);
    expect(r.isStale).toBe(true);
    expect(r.elapsedMs).toBe(18 * 60_000);
  });

  it('missing / invalid lastUpdate yields no readout and no escalation', () => {
    for (const bad of [undefined, 0, -1, NaN, Infinity]) {
      const r = deriveWorkLongevity(bad as number | undefined, NOW);
      expect(r).toEqual({ elapsedMs: 0, showElapsed: false, isStale: false });
    }
  });

  it('clock skew (lastUpdate in the future) clamps to 0, never negative', () => {
    const r = deriveWorkLongevity(NOW + 30_000, NOW);
    expect(r.elapsedMs).toBe(0);
    expect(r.showElapsed).toBe(false);
    expect(r.isStale).toBe(false);
  });
});

describe('formatElapsedCompact', () => {
  it('renders whole minutes without seconds', () => {
    expect(formatElapsedCompact(2 * 60_000)).toBe('2m');
    expect(formatElapsedCompact(18 * 60_000 + 43_000)).toBe('18m');
    expect(formatElapsedCompact(59 * 60_000)).toBe('59m');
  });

  it('renders hours + minutes past an hour', () => {
    expect(formatElapsedCompact(60 * 60_000)).toBe('1h 00m');
    expect(formatElapsedCompact(62 * 60_000)).toBe('1h 02m');
  });

  it('never renders "0m" and is empty for invalid input', () => {
    expect(formatElapsedCompact(30_000)).toBe('1m');
    expect(formatElapsedCompact(-1)).toBe('');
    expect(formatElapsedCompact(NaN)).toBe('');
  });
});

/** @covers USAGE-26 */
import { describe, expect, test } from 'bun:test';
import { clockOf, formatTps, readConsumption, shareFraction } from './sessionConsumption';

describe('readConsumption', () => {
  test('a wrong-typed answer is an empty one, not a crash', () => {
    expect(readConsumption(null).sessions).toEqual([]);
    expect(readConsumption({ sessions: 'x', unattributed: 4 }).unattributed).toEqual({ memMB: 0, cpuPct: null, processes: 0 });
  });

  test('keeps null as not measured and drops rows without a key', () => {
    const a = readConsumption({
      at: 5, windowS: 30,
      sessions: [
        { key: 'card:1', kind: 'card', title: 'T', tps: null, memMB: null, tokens: { total: 10, input: null, output: null, cacheRead: null, cacheWrite: null, source: 'card' }, shares: [{ id: 'server', mb: 1, totalMB: 2, of: 2, cpuPct: null }, { id: 'x' }] },
        { title: 'no key' },
      ],
    });
    expect(a.sessions).toHaveLength(1);
    const s = a.sessions[0]!;
    expect(s.tps).toBeNull();
    expect(s.memMB).toBeNull();
    expect(s.tokens?.source).toBe('card');
    expect(s.shares).toHaveLength(1);
    expect(s.state).toBe('working');
  });
});

describe('formatters', () => {
  test('clock runs in seconds and grows an hour part only past an hour', () => {
    expect(clockOf(0)).toBe('0:00');
    expect(clockOf(247_000)).toBe('4:07');
    expect(clockOf(3_600_000 + 12 * 60_000 + 9_000)).toBe('1:12:09');
    expect(clockOf(-5)).toBe('0:00');
  });
  test('tokens per second', () => {
    expect(formatTps(0)).toBe('0');
    expect(formatTps(3.46)).toBe('3,5');
    expect(formatTps(142.6)).toBe('143');
  });
  test('a share is a fraction', () => {
    expect(shareFraction({ id: 'server', mb: 1, totalMB: 3, of: 3, cpuPct: null })).toBe('1/3');
  });
});

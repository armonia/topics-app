/**
 * The cron panel reads the schedule in the shape the gateway sends.
 *
 * The gateway's `at` schedule is `{kind: 'at', at: <ISO date>}`; the panel only
 * read `atMs`, so every one-shot job (13 of 42 on the gateway it was measured
 * on) showed '-'. Event-driven jobs come with no schedule at all.
 *
 * @covers CRONRPC-01
 */
import { describe, expect, test } from 'bun:test';
import { formatSchedule } from './cronSchedule';

const fmt = (ms: number) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

describe('formatSchedule', () => {
  test("an 'at' schedule with the gateway's ISO date shows the date", () => {
    const at = '2026-10-23T01:30:00.000Z';
    expect(formatSchedule({ kind: 'at', at })).toBe(fmt(Date.parse(at)));
  });

  test("the older 'atMs' still reads", () => {
    expect(formatSchedule({ kind: 'at', atMs: 1_792_719_000_000 })).toBe(fmt(1_792_719_000_000));
  });

  test("a job without a schedule shows '-'", () => {
    expect(formatSchedule(undefined)).toBe('-');
  });

  test('every and cron keep their shorthand', () => {
    expect(formatSchedule({ kind: 'every', everyMs: 3_600_000 })).toBe('every 1h');
    expect(formatSchedule({ kind: 'cron', expr: '0 2 * * *' })).toBe('0 2 * * *');
  });
});

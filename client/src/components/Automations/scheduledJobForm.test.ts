import { describe, expect, test } from 'bun:test';
import { previewOccurrences, splitCommand } from '../../lib/scheduledJobs';
import { draftOf, emptyDraft, inputOf, scheduleOf } from './scheduledJobForm';

describe('the scheduled job form', () => {
  test('a daily draft writes a cron rule at the chosen time', () => {
    const draft = { ...emptyDraft(), whenKind: 'daily' as const, time: '18:30', timeZone: 'Europe/Rome' };
    expect(scheduleOf(draft)).toEqual({ kind: 'cron', expr: '30 18 * * *', tz: 'Europe/Rome' });
  });

  test('a command line keeps a quoted stretch as one word', () => {
    expect(splitCommand(`echo "a b" 'c d' e`)).toEqual(['echo', 'a b', 'c d', 'e']);
  });

  test('a job read back into the form writes the same request', () => {
    const input = inputOf({ ...emptyDraft(), name: ' Saluto ', commandLine: 'echo "a b"', whenKind: 'every', everyMinutes: '10', deliver: 'owner' });
    const job = { id: 'j', createdBy: 'user', enabled: true, nextRunAt: null, lastRun: null, ...input };
    expect(inputOf(draftOf(job))).toEqual(input);
    expect(input.name).toBe('Saluto');
  });

  test('the preview lists three occurrences and refuses a rule the server would refuse', () => {
    const now = new Date('2030-03-04T08:00:00Z');
    const ok = previewOccurrences({ kind: 'cron', expr: '30 18 * * *', tz: 'UTC' }, now, true);
    expect(ok.ok && ok.at.map((d) => d.toISOString())).toEqual(['2030-03-04T18:30:00.000Z', '2030-03-05T18:30:00.000Z', '2030-03-06T18:30:00.000Z']);
    expect(previewOccurrences({ kind: 'cron', expr: '61 * * * *', tz: 'UTC' }, now, true).ok).toBe(false);
    expect(previewOccurrences({ kind: 'at', at: '2020-01-01T00:00:00Z' }, now, true).ok).toBe(false);
  });
});

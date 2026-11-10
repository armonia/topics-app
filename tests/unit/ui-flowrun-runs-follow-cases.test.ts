import { describe, expect, test } from 'bun:test';
import { runsOf } from '../../client/src/ui/fixtures/flowrun';
import { CASES } from '../../client/src/ui/fixtures/org/cases';

const runs = runsOf('pec');

describe('simulated runs agree with the example cases', () => {
  test('a run of an unconfirmed case has no protocol number and waits for the person', () => {
    for (const run of runs) {
      const example = CASES.find((c) => c.id === run.caseId);
      if (example?.status !== 'da-confermare') continue;
      expect(run.protocol).toBeUndefined();
      expect(['person', 'error', 'blocked']).toContain(run.status);
    }
  });

  test('nothing finishes at the robot step after it stopped at 09:50', () => {
    const stop = '2026-11-06T09:50:00+01:00';
    const late = runs.filter((r) => r.day === 'today' && r.arrived >= stop && r.type !== 'G');
    expect(late.length).toBeGreaterThan(0);
    for (const run of late) expect(run.status).not.toBe('done');
  });

  test('the stopped run points to a case that exists', () => {
    expect(CASES.some((c) => c.id === '2417')).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';
import { highestSeverity, parseHealth } from './systemHealth';
import type { HealthProblem } from '../../../shared/agents-health';

const p = (severity: HealthProblem['severity']): HealthProblem => ({ id: severity, type: 't', severity, sentence: 's', destination: { section: 'memory' } });

describe('systemHealth', () => {
  test('no problem shows no colour, the worst severity wins otherwise', () => {
    expect(highestSeverity([])).toBeNull();
    expect(highestSeverity([p('warning')])).toBe('warning');
    expect(highestSeverity([p('warning'), p('error')])).toBe('error');
  });

  test('an answer without a list is no answer', () => {
    expect(parseHealth(null)).toBeNull();
    expect(parseHealth({ problems: [p('error')] })).toHaveLength(1);
  });
});

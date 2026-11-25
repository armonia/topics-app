/**
 * @covers SYSTEM-PAGE-01
 */
import { describe, expect, test } from 'bun:test';
import { healthTarget, systemSectionFromHash } from './systemNav';

describe('systemNav', () => {
  test('a hash names a section, anything else names none', () => {
    expect(systemSectionFromHash('#sistema/memory')).toBe('memory');
    expect(systemSectionFromHash('#sistema/nope')).toBeNull();
    expect(systemSectionFromHash('#agenti')).toBeNull();
  });

  test('a problem of an agent opens that agent, one without goes to the section about it', () => {
    expect(healthTarget({ section: 'memory', agentId: 'main' })).toEqual({ kind: 'agent', agentId: 'main', section: 'memory' });
    expect(healthTarget({ section: 'memory' })).toEqual({ kind: 'system', section: 'memory' });
    expect(healthTarget({ section: 'jobs' })).toEqual({ kind: 'automations' });
    expect(healthTarget({ section: 'rules' })).toEqual({ kind: 'system', section: 'harness' });
  });
});

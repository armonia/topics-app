import { describe, expect, test } from 'bun:test';
import { isEditable } from './scheduledJobForm';
import type { ScheduledJob } from '../../lib/scheduledJobs';

const jobWith = (action: unknown) => ({ id: 'j', action }) as unknown as ScheduledJob;

describe('which jobs the form can edit', () => {
  test('a command can be edited, a board card cannot (the server never changes the kind of an action)', () => {
    expect(isEditable(jobWith({ kind: 'command', argv: ['echo'], cwd: '/tmp' }))).toBe(true);
    expect(isEditable(jobWith({ kind: 'card', text: 'x' }))).toBe(false);
    expect(isEditable(jobWith({ kind: 'agent' }))).toBe(false);
  });
});
